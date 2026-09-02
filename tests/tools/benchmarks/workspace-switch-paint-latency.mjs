#!/usr/bin/env node
/**
 * Measures how long a workspace-card click takes to become VISIBLE.
 *
 * The existing e2e spec (tests/e2e/worktree-switch-responsiveness.spec.ts) only
 * measures the synchronous click task. That stays fast even when the symptom is
 * present: `markSidebarWorktreeActiveImmediately` mutates the DOM in the click
 * handler, so the attribute flips in ~1ms. What the user sees is the next
 * painted FRAME, and that frame is blocked when the async activation path jams
 * the main thread. So the number that matters is first-paint-after-click.
 *
 * Attaches over CDP to an already-running dev app:
 *
 *   ORCA_DEV_USER_DATA_PATH=... REMOTE_DEBUGGING_PORT=9455 pn dev
 *   node tests/tools/benchmarks/workspace-switch-paint-latency.mjs --port 9455
 *
 * Exits non-zero when the median first-paint exceeds --budget (default 200ms),
 * which makes it usable directly as a `git bisect run` predicate.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@stablyai/playwright-test'

function parseArgs(argv) {
  const args = {
    port: 9455,
    switches: 6,
    budgetMs: 200,
    settleMs: 2500,
    out: null,
    json: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split('=')
    const value = inlineValue ?? argv[i + 1]
    const consume = () => {
      if (inlineValue === undefined) {
        i += 1
      }
    }
    switch (flag) {
      case '--port':
        args.port = Number(value)
        consume()
        break
      case '--switches':
        args.switches = Number(value)
        consume()
        break
      case '--budget':
        args.budgetMs = Number(value)
        consume()
        break
      case '--settle':
        args.settleMs = Number(value)
        consume()
        break
      case '--out':
        args.out = value
        consume()
        break
      case '--json':
        args.json = true
        break
      case '--help':
        console.log(
          'Usage: workspace-switch-paint-latency.mjs [--port 9455] [--switches 6] [--budget 200] [--settle 2500] [--out file.json] [--json]'
        )
        process.exit(0)
        break
      default:
        break
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

function quantile(sorted, q) {
  if (sorted.length === 0) {
    return null
  }
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) {
    return sorted[lo]
  }
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function summarize(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (clean.length === 0) {
    return null
  }
  const sorted = [...clean].sort((a, b) => a - b)
  return {
    n: sorted.length,
    min: +sorted[0].toFixed(1),
    p50: +quantile(sorted, 0.5).toFixed(1),
    p90: +quantile(sorted, 0.9).toFixed(1),
    max: +sorted.at(-1).toFixed(1)
  }
}

/**
 * Installed in the renderer before each click. Records, from the real
 * pointerdown, every animation frame plus long tasks, so we can tell a jammed
 * main thread (no frames for ~1s) apart from slow-but-smooth work.
 */
const PROBE_SOURCE = `(targetId) => {
  const probe = {
    t0: null,
    targetId,
    frames: [],
    longTasks: [],
    attrFlipMs: null,
    storeCommitMs: null,
    renderedCommitMs: null,
    done: false
  }
  window.__switchProbe = probe

  const surfaceOf = (id) => {
    const row = [...document.querySelectorAll('[data-worktree-id]')].find(
      (el) => el.dataset.worktreeId === id
    )
    return row ? row.querySelector('[data-worktree-card-surface]') : null
  }
  const isActive = (id) => {
    const s = surfaceOf(id)
    return Boolean(s && s.getAttribute('data-worktree-card-active'))
  }
  const renderedId = () =>
    document
      .querySelector('[data-rendered-active-worktree-id]')
      ?.getAttribute('data-rendered-active-worktree-id') ?? null

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (probe.t0 === null) continue
        probe.longTasks.push({
          startMs: +(e.startTime - probe.t0).toFixed(1),
          durationMs: +e.duration.toFixed(1)
        })
      }
    })
    po.observe({ entryTypes: ['longtask'] })
    probe.observer = po
  } catch {}

  // Why: pointerdown is the earliest thing the user's click produces, so it is
  // the honest zero point for "time until I saw something happen".
  const onPointerDown = () => {
    if (probe.t0 !== null) return
    probe.t0 = performance.now()
    const tick = () => {
      const now = performance.now() - probe.t0
      probe.frames.push(+now.toFixed(1))
      if (probe.attrFlipMs === null && isActive(probe.targetId)) probe.attrFlipMs = +now.toFixed(1)
      if (probe.storeCommitMs === null) {
        const st = window.__store?.getState?.()
        if (st && st.activeWorktreeId === probe.targetId) probe.storeCommitMs = +now.toFixed(1)
      }
      if (probe.renderedCommitMs === null && renderedId() === probe.targetId) {
        probe.renderedCommitMs = +now.toFixed(1)
      }
      if (!probe.done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  window.addEventListener('pointerdown', onPointerDown, { capture: true, once: true })
  probe.cleanup = () => {
    probe.done = true
    try { probe.observer?.disconnect() } catch {}
    window.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }
  return true
}`

/** Press Escape while any full-screen overlay is intercepting pointer events. */
async function dismissOverlays(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const blocked = await page.evaluate(() =>
      [...document.querySelectorAll('body *')].some((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < window.innerWidth * 0.9 || r.height < window.innerHeight * 0.9) {
          return false
        }
        const s = getComputedStyle(el)
        return s.position === 'fixed' && s.pointerEvents !== 'none' && Number(s.zIndex) >= 40
      })
    )
    if (!blocked) {
      return
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${args.port}`)
  const contexts = browser.contexts()
  const pages = contexts.flatMap((c) => c.pages())
  let page = null
  for (const candidate of pages) {
    const hasStore = await candidate
      .evaluate(
        () => Boolean(window.__store) && Boolean(document.querySelector('[data-worktree-id]'))
      )
      .catch(() => false)
    if (hasStore) {
      page = candidate
      break
    }
  }
  if (!page) {
    throw new Error(
      'No renderer page with window.__store + a mounted sidebar. Is the app past startup, and is the sidebar open?'
    )
  }

  // Normalize sidebar state so the same cards are reachable across commits.
  // Why pin the sort: 'recent' reorders the list after every switch, which
  // would move the card out from under the cursor mid-run.
  const worktreeIds = await page.evaluate(() => {
    const state = window.__store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy?.('none')
    state.setSortBy?.('name')
    state.setShowActiveOnly?.(false)
    state.setFilterRepoIds?.([])
    const viewportH = window.innerHeight
    // Only cards fully inside the viewport are clickable: the list is
    // virtualized, so off-screen rows are unmounted or positioned outside.
    return [...document.querySelectorAll('[data-worktree-id]')]
      .filter((el) => {
        const surface = el.querySelector('[data-worktree-card-surface]')
        if (!surface) {
          return false
        }
        const r = surface.getBoundingClientRect()
        return r.height > 0 && r.top >= 0 && r.bottom <= viewportH
      })
      .map((el) => el.dataset.worktreeId)
      .filter((id, i, all) => id && all.indexOf(id) === i)
  })

  if (worktreeIds.length < 2) {
    throw new Error(
      `Need >=2 workspace cards visible in the viewport, found ${worktreeIds.length}. Is the sidebar open?`
    )
  }

  // Alternate between two cards, neither of which is the one already active at
  // start — clicking the active card short-circuits and measures nothing.
  const activeAtStart = await page.evaluate(() => window.__store.getState().activeWorktreeId)
  const pair = worktreeIds.filter((id) => id !== activeAtStart).slice(0, 2)
  if (pair.length < 2) {
    throw new Error('Need two visible non-active cards to alternate between')
  }
  console.error(`alternating between:\n  ${pair[0]}\n  ${pair[1]}`)

  const samples = []
  for (let i = 0; i < args.switches; i += 1) {
    const targetId = pair[i % 2]

    // Why: page.evaluate() treats a string as an expression to evaluate and
    // drops the argument, so the probe has to be applied inline.
    const surface = page
      .locator(`[data-worktree-id="${targetId}"] [data-worktree-card-surface]`)
      .first()

    // Why: a transient popover (`fixed inset-0 z-50`) swallows the click, and
    // the run would then measure a click that never reached the card.
    await dismissOverlays(page)

    await page.evaluate(`(${PROBE_SOURCE})(${JSON.stringify(targetId)})`)

    // Real CDP input events, not element.click(): the click path has
    // pointer-drag suppression that a synthetic click would bypass. Going
    // through the locator also re-resolves position at click time, which
    // matters because the virtualized list reorders between switches.
    try {
      await surface.click({ timeout: 10_000 })
    } catch (error) {
      console.error(`skip switch ${i + 1}: ${String(error).split('\n')[0]}`)
      continue
    }

    await page.waitForTimeout(args.settleMs)

    const sample = await page.evaluate(() => {
      const p = window.__switchProbe
      p.cleanup?.()
      const frames = p.frames
      let maxGap = 0
      let prev = 0
      for (const f of frames) {
        maxGap = Math.max(maxGap, f - prev)
        prev = f
      }
      return {
        firstPaintMs: frames.length ? frames[0] : null,
        maxFrameGapMs: +maxGap.toFixed(1),
        frameCount: frames.length,
        attrFlipMs: p.attrFlipMs,
        storeCommitMs: p.storeCommitMs,
        renderedCommitMs: p.renderedCommitMs,
        longTaskCount: p.longTasks.length,
        longTaskTotalMs: +p.longTasks.reduce((a, t) => a + t.durationMs, 0).toFixed(1),
        worstLongTaskMs: p.longTasks.reduce((a, t) => Math.max(a, t.durationMs), 0)
      }
    })
    sample.targetId = targetId
    // Why: a click that never activated would report a fast "first paint" and
    // silently make every commit look good during a bisect.
    if (sample.attrFlipMs === null && sample.renderedCommitMs === null) {
      throw new Error(
        `switch ${i + 1} clicked card ${targetId} but it never became active — the measurement is not valid`
      )
    }
    samples.push(sample)
    console.error(
      `switch ${i + 1}/${args.switches} -> firstPaint=${sample.firstPaintMs}ms ` +
        `maxFrameGap=${sample.maxFrameGapMs}ms attrFlip=${sample.attrFlipMs}ms ` +
        `rendered=${sample.renderedCommitMs}ms longTasks=${sample.longTaskCount}/${sample.longTaskTotalMs}ms`
    )
  }

  // Why: the first switch after attach pays one-off lazy work (chunk loads,
  // cold caches) that a warm app never pays again. Keep it in the raw samples
  // but exclude it from the verdict so bisect steps compare like with like.
  const scored = samples.length > 1 ? samples.slice(1) : samples

  const report = {
    port: args.port,
    switches: samples.length,
    budgetMs: args.budgetMs,
    firstPaintMs: summarize(scored.map((s) => s.firstPaintMs)),
    maxFrameGapMs: summarize(scored.map((s) => s.maxFrameGapMs)),
    attrFlipMs: summarize(scored.map((s) => s.attrFlipMs)),
    renderedCommitMs: summarize(scored.map((s) => s.renderedCommitMs)),
    worstLongTaskMs: summarize(scored.map((s) => s.worstLongTaskMs)),
    longTaskTotalMs: summarize(scored.map((s) => s.longTaskTotalMs)),
    samples
  }

  const medianFirstPaint = report.firstPaintMs?.p50 ?? Infinity
  const medianFrameGap = report.maxFrameGapMs?.p50 ?? Infinity
  // The visible symptom is a stall, which shows up either as a late first frame
  // or as a long gap between frames right after the click.
  const verdictMs = Math.max(medianFirstPaint, medianFrameGap)
  report.verdictMs = +verdictMs.toFixed(1)
  report.pass = verdictMs <= args.budgetMs

  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true })
    writeFileSync(args.out, JSON.stringify(report, null, 2))
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('')
    console.log(
      `first paint after click   p50=${report.firstPaintMs?.p50}ms  max=${report.firstPaintMs?.max}ms`
    )
    console.log(
      `max frame gap             p50=${report.maxFrameGapMs?.p50}ms  max=${report.maxFrameGapMs?.max}ms`
    )
    console.log(`attribute flip (JS)       p50=${report.attrFlipMs?.p50}ms`)
    console.log(
      `main pane rendered        p50=${report.renderedCommitMs?.p50}ms  max=${report.renderedCommitMs?.max}ms`
    )
    console.log(
      `worst long task           p50=${report.worstLongTaskMs?.p50}ms  max=${report.worstLongTaskMs?.max}ms`
    )
    console.log('')
    console.log(
      `${report.pass ? 'PASS' : 'FAIL'} verdict=${report.verdictMs}ms budget=${args.budgetMs}ms`
    )
  }

  await browser.close()
  process.exit(report.pass ? 0 : 1)
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  // 125 tells `git bisect run` to skip rather than mark the commit bad.
  process.exit(125)
})
