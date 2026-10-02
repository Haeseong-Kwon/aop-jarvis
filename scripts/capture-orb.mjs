// Visual regression captures of the Orb via the Orb Lab harness.
// Usage: node scripts/capture-orb.mjs <outDir> [baseUrl]   (start `pnpm --filter desktop dev` first)
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
let pw
try { pw = require('playwright') } catch { pw = require('/opt/node-tools/node_modules/playwright') }

const out = process.argv[2] ?? 'docs/captures/after'
const base = process.argv[3] ?? 'http://localhost:1420'
const extra = process.argv[4] ?? ''
const states = (process.env.STATES ?? 'DORMANT,ONLINE,LISTENING,THINKING,EXECUTING,SPEAKING,WAITING_APPROVAL,ERROR').split(',')
mkdirSync(out, { recursive: true })
const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM ?? undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const dsf = Number(process.env.DSF ?? 1)
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: dsf })
// CLIP=x,y,w,h crops the capture (CSS px) — useful for close-up inspection of the core.
const clip = process.env.CLIP ? Object.fromEntries(['x', 'y', 'width', 'height'].map((k, i) => [k, Number(process.env.CLIP.split(',')[i])])) : undefined
page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()))
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
for (const s of states) {
  await page.goto(`${base}/orb-lab.html?state=${s}${extra}`)
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 4500))
  await page.screenshot({ path: `${out}/${s.toLowerCase()}${clip ? '-crop' : ''}.png`, clip, timeout: 180000 })
  const stats = await page.evaluate(() => window.orb?.stats?.() ?? null)
  console.log(s, stats ? JSON.stringify(stats) : '')
}
await browser.close()
