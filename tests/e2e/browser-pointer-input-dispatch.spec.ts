/**
 * E2E coverage for coordinate pointer input (browser.mouseMove/Down/Up/Wheel).
 *
 * Drives the exact RPC sequences BrowserPane sends, measures their cost, and checks the
 * gestures they must produce: click, double-click, right-click, drag-selection, and a
 * wheel that scrolls the element under the cursor.
 */

import { createServer, type Server } from 'node:http'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

type RuntimeResponse = {
  ok: boolean
  result?: unknown
  error?: unknown
}

function readProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

function toRuntimeResponse(value: unknown): RuntimeResponse {
  return {
    ok: readProperty(value, 'ok') === true,
    result: readProperty(value, 'result'),
    error: readProperty(value, 'error')
  }
}

const PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Pointer input probe</title>
    <style>
      html, body { margin: 0; font: 16px/1.4 monospace; }
      #target { position: absolute; left: 40px; top: 40px; width: 240px; height: 60px; }
      #word { position: absolute; left: 40px; top: 140px; font-size: 24px; user-select: text; }
      #scroller { position: absolute; left: 40px; top: 220px; width: 300px; height: 160px; overflow: auto; }
      #scroller .filler { height: 4000px; }
    </style>
  </head>
  <body>
    <button id="target">target</button>
    <div id="word">alpha bravo charlie</div>
    <div id="scroller"><div class="filler"></div></div>
    <script>
      window.__events = []
      const record = (event) => {
        window.__events.push({
          type: event.type,
          detail: event.detail ?? 0,
          button: event.button ?? 0,
          x: Math.round(event.clientX ?? 0),
          y: Math.round(event.clientY ?? 0),
          t: Date.now()
        })
      }
      for (const name of ['click', 'dblclick', 'contextmenu', 'auxclick', 'mousedown', 'mouseup']) {
        document.addEventListener(name, record, true)
      }
      document.addEventListener('contextmenu', (event) => event.preventDefault())
    </script>
  </body>
</html>`

async function startProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Probe server did not bind a TCP port')
  }
  const url = `http://127.0.0.1:${address.port}/`
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

async function createBrowserTab(page: Page, worktreeId: string, url: string): Promise<string> {
  const pageId = await page.evaluate(
    ({ targetWorktreeId, targetUrl }) => {
      const created = window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
        title: 'Pointer input probe',
        activate: true
      })
      return created?.activePageId ?? null
    },
    { targetWorktreeId: worktreeId, targetUrl: url }
  )
  if (!pageId) {
    throw new Error('Failed to create the probe browser page')
  }
  return pageId
}

async function rpc(
  page: Page,
  method: string,
  params: Record<string, unknown>
): Promise<RuntimeResponse> {
  return toRuntimeResponse(
    await page.evaluate(
      ({ targetMethod, targetParams }) =>
        window.api.runtime.call({ method: targetMethod, params: targetParams }),
      { targetMethod: method, targetParams: params }
    )
  )
}

async function expectOk(
  page: Page,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response = await rpc(page, method, params)
  expect(response, `${method} failed: ${JSON.stringify(response.error)}`).toMatchObject({
    ok: true
  })
  return response.result
}

async function evaluateInPage(page: Page, pageId: string, expression: string): Promise<unknown> {
  const result = await expectOk(page, 'browser.eval', { page: pageId, expression })
  return readProperty(result, 'result')
}

// Why: Chromium's own multi-click interval; a pair wider than this is two single clicks.
const DOUBLE_CLICK_INTERVAL_MS = 500

type RpcStep = [string, Record<string, unknown>]

// Why: one Playwright round-trip for the whole gesture. Driving each RPC from Node instead
// puts ~750ms of harness IPC between events on a loaded CI runner, which pushes a click
// pair outside the 500ms double-click interval and makes the harness the thing under test.
async function driveRpcSequence(page: Page, pageId: string, steps: RpcStep[]): Promise<void> {
  const failure = await page.evaluate(
    async ({ targetPage, sequence }) => {
      for (const [method, params] of sequence) {
        const response: unknown = await window.api.runtime.call({
          method,
          params: { page: targetPage, ...params }
        })
        if (response === null || typeof response !== 'object' || !('ok' in response)) {
          return `${method} returned no response`
        }
        if (response.ok !== true) {
          return `${method} failed: ${JSON.stringify(response)}`
        }
      }
      return null
    },
    { targetPage: pageId, sequence: steps }
  )
  if (failure !== null) {
    throw new Error(failure)
  }
}

// Why: the pane sends move+down+move+up for one click, serialized.
function clickSteps(x: number, y: number, button = 'left'): RpcStep[] {
  return [
    ['browser.mouseMove', { x, y }],
    ['browser.mouseDown', { button }],
    ['browser.mouseMove', { x, y }],
    ['browser.mouseUp', { button }]
  ]
}

test('dispatches coordinate pointer input fast enough for real gestures', async ({ orcaPage }) => {
  // Why: the measurement loop plus the gesture checks drive a few hundred serialized RPCs;
  // a loaded CI runner needs more than the default budget even when each one is fast.
  test.setTimeout(240_000)
  const server = await startProbeServer()
  try {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).toBeTruthy()
    const pageId = await createBrowserTab(orcaPage, worktreeId!, server.url)

    await expect
      .poll(() => evaluateInPage(orcaPage, pageId, 'document.title'), { timeout: 20_000 })
      .toBe('Pointer input probe')

    // ── Latency ──

    // Why: every sample runs inside the renderer, so it times the RPC the pane awaits
    // rather than the Playwright round-trip. The renderer's performance.now() is coarsened
    // to ~16.6ms, so each operation is timed in bulk and averaged instead of per call.
    const latency = await orcaPage.evaluate(async (targetPage) => {
      const call = async (method: string, params: Record<string, unknown>): Promise<void> => {
        const response: unknown = await window.api.runtime.call({
          method,
          params: { page: targetPage, ...params }
        })
        if (response === null || typeof response !== 'object' || !('ok' in response)) {
          throw new Error(`${method} returned no response`)
        }
        if (response.ok !== true) {
          throw new Error(`${method} failed: ${JSON.stringify(response)}`)
        }
      }
      // Why: enough to amortize the renderer's ~16.6ms clock coarsening (<1.4ms error
      // against a floor of tens of ms) without spending a CI runner's whole test budget.
      const REPEATS = 12
      const meanMs = async (run: (index: number) => Promise<void>): Promise<number> => {
        await run(0)
        const started = performance.now()
        for (let i = 0; i < REPEATS; i += 1) {
          await run(i)
        }
        return (performance.now() - started) / REPEATS
      }

      return {
        // Why: the control — same socket, same queue, no pointer dispatch. Anything a
        // pointer event costs above this is the dispatch itself.
        evalControl: await meanMs(() => call('browser.eval', { expression: '1' })),
        mouseMove: await meanMs((i) => call('browser.mouseMove', { x: 60 + (i % 20), y: 300 })),
        mouseWheel: await meanMs(() => call('browser.mouseWheel', { dy: 1 })),
        click: await meanMs(async (i) => {
          await call('browser.mouseMove', { x: 400 + (i % 10), y: 400 })
          await call('browser.mouseDown', { button: 'left' })
          await call('browser.mouseMove', { x: 400 + (i % 10), y: 400 })
          await call('browser.mouseUp', { button: 'left' })
        })
      }
    }, pageId)
    const latencyReport = JSON.stringify(latency)
    console.log(`POINTER_LATENCY ${latencyReport}`)
    // Why: Playwright does not surface a passing test's stdout in the CI job log, so the
    // numbers ride along in the annotation where the failure artifact will carry them.
    test.info().annotations.push({ type: 'pointer-latency', description: latencyReport })

    // Why: absolute milliseconds vary by host, so compare against browser.eval on the same
    // socket and queue — a pointer event that spawns the helper costs that plus a process
    // launch. Measured multiples of the control: in process 1.5x/1.5x/4x, via the helper
    // 5.7x/5.5x/20.5x. These thresholds sit between the two, not near either.
    expect(latency.mouseMove, latencyReport).toBeLessThan(latency.evalControl * 3)
    expect(latency.mouseWheel, latencyReport).toBeLessThan(latency.evalControl * 3)
    expect(latency.click, latencyReport).toBeLessThan(latency.evalControl * 10)

    // ── Gesture fidelity ──

    await evaluateInPage(orcaPage, pageId, 'window.__events = []; true')
    const clickPairStarted = Date.now()
    await driveRpcSequence(orcaPage, pageId, [...clickSteps(120, 60), ...clickSteps(120, 60)])
    const clickPairMs = Date.now() - clickPairStarted

    const pressTimes = JSON.parse(
      String(
        await evaluateInPage(
          orcaPage,
          pageId,
          'JSON.stringify(window.__events.filter((e) => e.type === "mousedown").map((e) => e.t))'
        )
      )
    )
    const pressGapMs = Number(pressTimes[1]) - Number(pressTimes[0])
    const cadenceReport = `${latencyReport} clickPairMs=${clickPairMs} pressGapMs=${pressGapMs}`
    console.log(`POINTER_CADENCE ${cadenceReport}`)
    test.info().annotations.push({ type: 'pointer-cadence', description: cadenceReport })

    const clickEvents = String(
      await evaluateInPage(
        orcaPage,
        pageId,
        'JSON.stringify(window.__events.filter((e) => e.type === "click" || e.type === "dblclick"))'
      )
    )
    const parsedClicks: unknown[] = JSON.parse(clickEvents)
    const eventsOfType = (type: string): unknown[] =>
      parsedClicks.filter((event) => readProperty(event, 'type') === type)
    console.log(`POINTER_CLICKS ${clickEvents}`)
    expect(eventsOfType('click'), cadenceReport).toHaveLength(2)

    // Why: dblclick needs both presses inside Chromium's 500ms interval, which is a
    // property of how fast the host can serve five RPCs, not of the dispatch path. A
    // runner too slow to express a double-click at all reports that as unverified rather
    // than as a missing dblclick — the clickCount cadence itself is covered deterministically
    // by agent-browser-bridge-pointer-input.test.ts under fake timers.
    if (pressGapMs >= DOUBLE_CLICK_INTERVAL_MS) {
      test.info().annotations.push({
        type: 'pointer-dblclick-unverified',
        description: `presses were ${pressGapMs}ms apart, outside the ${DOUBLE_CLICK_INTERVAL_MS}ms interval — ${cadenceReport}`
      })
    } else {
      expect(eventsOfType('dblclick'), cadenceReport).toHaveLength(1)
      expect(readProperty(eventsOfType('dblclick')[0], 'detail'), cadenceReport).toBe(2)
    }

    // ── Right click ──

    await evaluateInPage(orcaPage, pageId, 'window.__events = []; true')
    await driveRpcSequence(orcaPage, pageId, [
      ['browser.mouseMove', { x: 120, y: 60 }],
      ['browser.mouseDown', { button: 'right' }],
      ['browser.mouseUp', { button: 'right' }]
    ])
    await expect
      .poll(() =>
        evaluateInPage(orcaPage, pageId, 'window.__events.some((e) => e.type === "contextmenu")')
      )
      .toBe('true')

    // ── Drag selection ──

    await evaluateInPage(orcaPage, pageId, 'window.getSelection().removeAllRanges(); true')
    await driveRpcSequence(orcaPage, pageId, [
      ['browser.mouseMove', { x: 42, y: 155 }],
      ['browser.mouseDown', { button: 'left' }],
      ...[80, 120, 160, 200].map((x): RpcStep => ['browser.mouseMove', { x, y: 155 }]),
      ['browser.mouseUp', { button: 'left' }]
    ])
    await expect
      .poll(() => evaluateInPage(orcaPage, pageId, 'String(window.getSelection())'))
      .toContain('alpha')

    // ── Wheel targets the element under the cursor ──

    await evaluateInPage(
      orcaPage,
      pageId,
      'document.querySelector("#scroller").scrollTop = 0; window.scrollTo(0, 0); true'
    )
    await driveRpcSequence(orcaPage, pageId, [
      ['browser.mouseMove', { x: 180, y: 300 }],
      ...Array.from({ length: 6 }, (): RpcStep => ['browser.mouseWheel', { dy: 120 }])
    ])
    await expect
      .poll(
        async () =>
          Number(
            await evaluateInPage(orcaPage, pageId, 'document.querySelector("#scroller").scrollTop')
          ),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0)
  } finally {
    await server.close()
  }
})
