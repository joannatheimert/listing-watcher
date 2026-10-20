import fs from 'fs'
import fetch from 'node-fetch'
import * as cheerio from 'cheerio'
import cron from 'node-cron'
import { program } from 'commander'

program
    .version('2.1.0', '-v, --version')
    .usage('[OPTIONS]...')
    .option('-f, --force', 'Run once and exit instead of scheduling')
    .option('--list', 'Print every listing with its detected status and exit (nothing saved, nothing sent)')
    .option('--test-notify', 'Send a test notification and exit')
    .option('--no-notify', 'Do not send notifications when new listings are found')
    .parse()

const options = program.opts()

// ---------- Config ----------
const NTFY_SERVER = process.env.NTFY_SERVER ?? 'https://ntfy.sh'
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? 'change-me-to-a-long-random-string'
const STATE_FILE = './listings.json'
const SCHEDULE = '*/5 * * * *'
const USER_AGENT = 'Mozilla/5.0 (personal listing watcher)'

// A listing whose card contains one of these texts is ignored (no notification, not saved).
const SKIP_STATUSES = ['Reserveret', 'Lukket for henvendelser', 'Udlejet']

// To watch another site, add an entry here.
const SITES = [
    {
        key: 'cej',
        name: 'CEJ',
        url: 'https://udlejning.cej.dk/find-bolig/overblik?collection=residences&minRooms=2&monthlyPrice=0-50000&p=sj%C3%A6lland&types=apartment',
        linkSelector: 'a[href*="/boliger/"]',
        pathPrefix: '/boliger/',
        title: ($a) => $a.find('h6').first().text(),
    },
    {
        key: 'kereby',
        name: 'Kereby',
        url: 'https://kereby.dk/bolig/',
        linkSelector: 'a[href*="/bolig/"]',
        pathPrefix: '/bolig/',
    },
]

// ---------- Helpers ----------
const clean = (s) => s.replace(/\s+/g, ' ').trim()

const PRICE_RE = /kr\.\s*\/\s*md/gi
// No word boundaries on purpose: cheerio's .text() often glues neighbouring elements together
// ("ReserveretDelevenlig 4-værelses"), and these status words don't occur inside other words.
const STATUS_RE = new RegExp(`(${SKIP_STATUSES.join('|')})`, 'i')

async function fetchHtml(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return res.text()
}

// Text of the whole listing card around a link. We climb up from the link as long as the
// surrounding element still contains at most one price ("kr./md"), i.e. still only one card.
function cardText($, el) {
    let node = $(el)
    for (let i = 0; i < 6; i++) {
        const parent = node.parent()
        if (!parent.length) break
        const prices = (parent.text().match(PRICE_RE) ?? []).length
        if (prices > 1) break
        node = parent
    }
    return clean(node.text())
}

function detectStatus(text) {
    const match = text.match(STATUS_RE)
    return match ? match[1] : null
}

function extractListings(html, site) {
    const $ = cheerio.load(html)
    const found = {}

    $(site.linkSelector).each((_, el) => {
        const href = $(el).attr('href')
        if (!href) return

        const url = new URL(href, site.url)
        if (!url.pathname.startsWith(site.pathPrefix) || url.pathname === site.pathPrefix) return

        const id = url.pathname.split('/').filter(Boolean).pop()
        const rawTitle = site.title ? site.title($(el)) : $(el).text()
        const title = clean(rawTitle).slice(0, 140) || id
        const status = detectStatus(cardText($, el))

        // The same listing can have several links (image + text): merge them
        const prev = found[id]
        found[id] = {
            title: prev && prev.title.length >= title.length ? prev.title : title,
            link: url.origin + url.pathname,
            status: prev?.status ?? status,
            foundAt: prev?.foundAt ?? new Date().toISOString(),
        }
    })

    return found
}

const toSaved = ({ title, link, foundAt }) => ({ title, link, foundAt })

function loadState() {
    return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : {}
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 4))
}

async function notify(site, listing) {
    const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
        method: 'POST',
        body: listing.title, // body can contain æ/ø/å
        headers: {
            // header values must stay plain ASCII
            Title: `New listing - ${site.name}`,
            Click: listing.link,
            Tags: 'house',
            Priority: 'high',
        },
        signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`ntfy responded with HTTP ${res.status}`)
}

// ---------- Main logic ----------
async function listSite(site) {
    const current = extractListings(await fetchHtml(site.url), site)
    console.log(`\n[${site.name}] ${Object.keys(current).length} listings`)
    for (const listing of Object.values(current)) {
        const label = listing.status ? `skip: ${listing.status}` : 'available'
        console.log(`  ${label.padEnd(34)} ${listing.title}`)
    }
}

async function checkSite(site, state) {
    const current = extractListings(await fetchHtml(site.url), site)
    const all = Object.entries(current)

    if (all.length === 0) {
        // Probably a layout change or a bad response: don't touch saved state
        console.warn(`[${site.name}] 0 listings found, skipping (has the page layout changed? try --list)`)
        return
    }

    const available = all.filter(([, listing]) => !listing.status)
    console.log(
        `[${site.name}] found ${all.length} listings (${available.length} available, ${all.length - available.length} skipped as reserved/closed/rented)`
    )
    if (available.length === 0) {
        console.warn(`[${site.name}] every listing was flagged as unavailable - check with --list`)
    }

    // Reserved/closed listings are deliberately not saved: if one becomes available again, you get notified.
    const firstRun = state[site.key] === undefined
    const saved = state[site.key] ?? {}

    if (firstRun) {
        console.log(`[${site.name}] first run: saving ${available.length} listings without notifying`)
        state[site.key] = Object.fromEntries(available.map(([id, l]) => [id, toSaved(l)]))
        return
    }

    const fresh = available.filter(([id]) => !(id in saved))
    if (fresh.length === 0) {
        console.log(`[${site.name}] no new listings`)
        return
    }

    console.log(`[${site.name}] ${fresh.length} new listing(s)`)
    for (const [id, listing] of fresh) {
        if (options.notify) {
            try {
                await notify(site, listing)
            } catch (err) {
                // Don't save it, so we retry on the next run
                console.error(`[${site.name}] notification failed for ${id}: ${err.message}`)
                continue
            }
        }
        saved[id] = toSaved(listing)
    }
    state[site.key] = saved
}

let running = false

async function run() {
    if (running) return // avoid overlapping runs
    running = true
    try {
        if (options.list) {
            for (const site of SITES) {
                try {
                    await listSite(site)
                } catch (err) {
                    console.error(`[${site.name}] failed: ${err.message}`)
                }
            }
            return
        }

        const state = loadState()
        for (const site of SITES) {
            try {
                await checkSite(site, state)
            } catch (err) {
                console.error(`[${site.name}] failed: ${err.message}`)
            }
        }
        saveState(state)
    } finally {
        running = false
    }
}

if (options.testNotify) {
    await notify({ name: 'Test' }, { title: 'Test notification from your listing watcher', link: SITES[0].url })
    console.log('Test notification sent')
} else if (options.force || options.list) {
    await run()
} else {
    console.log(`Watching ${SITES.map((s) => s.name).join(' + ')} (${SCHEDULE})`)
    run()
    cron.schedule(SCHEDULE, run)
}
