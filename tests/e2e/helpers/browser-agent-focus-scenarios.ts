// Keep agent browser input away from the user’s terminal focus; observe host keydowns and focus changes (#20595).

import { createServer, type Server } from 'node:http'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  waitForActiveWorktree
} from './store'

/** Runs after a scenario's agent input, with the probe page still open. */
export type AfterAgentInput = (pageId: string) => Promise<void>

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Focus isolation probe</title></head>
  <body>
    <form id="form"><input id="probe" /></form>
    <textarea id="notes"></textarea>
    <button id="target" style="position:absolute;left:40px;top:80px;width:200px;height:60px">target</button>
    <iframe id="frame" src="__FRAME_URL__" style="position:absolute;left:40px;top:200px;width:300px;height:80px"></iframe>
    <script>
      window.__frameValue = ''
      window.__frameKeys = []
      window.__frameReady = false
      addEventListener('message', (event) => {
        if (typeof event.data?.frameValue === 'string') window.__frameValue = event.data.frameValue
        if (typeof event.data?.frameKey === 'string') window.__frameKeys.push(event.data.frameKey)
        if (event.data?.frameReady) window.__frameReady = true
      })
      window.__keys = []
      window.__submits = 0
      window.__clicks = 0
      window.__blurs = 0
      document.getElementById('probe').addEventListener('blur', () => { window.__blurs += 1 })
      addEventListener('keydown', (event) => window.__keys.push(event.key), true)
      document.getElementById('form').addEventListener('submit', (event) => {
        event.preventDefault()
        window.__submits += 1
      })
      document.getElementById('target').addEventListener('click', () => { window.__clicks += 1 })
    </script>
  </body>
</html>`

// Serve this frame cross-site so Chromium isolates it in the process widget input cannot reach.
const FRAME_HTML = `<!doctype html>
<html>
  <body>
    <input id="field" style="position:absolute;left:0;top:0;width:280px;height:60px" />
    <script>
      const field = document.getElementById('field')
      // Why: a cross-site frame cannot focus itself without user activation, so the field takes
      // focus on the first key the frame receives.
      addEventListener(
        'keydown',
        (event) => {
          if (document.activeElement !== field) field.focus()
          parent.postMessage({ frameKey: event.key }, '*')
        },
        true
      )
      field.addEventListener('input', () => parent.postMessage({ frameValue: field.value }, '*'))
      parent.postMessage({ frameReady: true }, '*')
    </script>
  </body>
</html>`

export async function startProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const address = server.address()
    const port = address !== null && typeof address === 'object' ? address.port : 0
    response.end(
      request.url === '/frame'
        ? FRAME_HTML
        : PAGE_HTML.replace('__FRAME_URL__', `http://localhost:${port}/frame`)
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Probe server did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Close keep-alive sockets or Windows server.close waits until the suite times out.
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

export function readProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

export async function rpc(
  page: Page,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response: unknown = await page.evaluate(
    ({ targetMethod, targetParams }) =>
      window.api.runtime.call({ method: targetMethod, params: targetParams }),
    { targetMethod: method, targetParams: params }
  )
  expect(
    readProperty(response, 'ok'),
    `${method} failed: ${JSON.stringify(readProperty(response, 'error'))}`
  ).toBe(true)
  return readProperty(response, 'result')
}

export async function evalInPage(page: Page, pageId: string, expression: string): Promise<unknown> {
  return readProperty(await rpc(page, 'browser.eval', { page: pageId, expression }), 'result')
}

/** Focuses the terminal and records every host keydown and focus move from here on. */
async function focusTerminalAndWatchHost(page: Page): Promise<void> {
  await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!textarea) {
      throw new Error('No terminal input to focus')
    }
    textarea.focus()
    // Why: kept on the document so the read side needs no untyped window property.
    const log: string[] = []
    const record = (entry: string): void => {
      log.push(entry)
      document.documentElement.dataset.agentFocusProbeLog = JSON.stringify(log)
    }
    document.documentElement.dataset.agentFocusProbeLog = '[]'
    window.addEventListener('keydown', (event) => record(`key:${event.key}`), true)
    window.addEventListener('focusin', (event) => {
      const target = event.target
      record(`focus:${target instanceof Element ? target.tagName : 'window'}`)
    })
  })
}

export async function readHost(page: Page): Promise<{ log: string[]; terminalFocused: boolean }> {
  return page.evaluate(() => ({
    log: ((): string[] => {
      const parsed: unknown = JSON.parse(
        document.documentElement.dataset.agentFocusProbeLog ?? '[]'
      )
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : []
    })(),
    terminalFocused: document.activeElement?.classList.contains('xterm-helper-textarea') === true
  }))
}

/** Opens the probe in a browser tab, then puts the terminal back in front of it. */
export async function openBackgroundProbeTab(page: Page, url: string): Promise<string> {
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const worktreeId = await getActiveWorktreeId(page)
  expect(worktreeId).toBeTruthy()
  // Mount once to establish a viewport; never-shown tabs can stay 0×0 and miss clicks.
  const pageId = await page.evaluate(
    ({ targetWorktreeId, targetUrl }) =>
      window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
        title: 'Focus isolation probe',
        activate: true
      })?.activePageId ?? null,
    { targetWorktreeId: worktreeId!, targetUrl: url }
  )
  if (!pageId) {
    throw new Error('Failed to create the probe browser page')
  }
  // Wait for script readiness too; the title can exist before input logging starts.
  const readiness = `document.readyState === 'complete' && innerWidth > 0 && 'clicks' + window.__clicks`
  await expect.poll(() => evalInPage(page, pageId, readiness), { timeout: 20_000 }).toBe('clicks0')
  await ensureTerminalVisible(page)
  await expect.poll(() => evalInPage(page, pageId, readiness)).toBe('clicks0')
  return pageId
}

export async function runAgentKeysScenario(
  page: Page,
  afterAgentInput?: AfterAgentInput
): Promise<void> {
  const server = await startProbeServer()
  try {
    const pageId = await openBackgroundProbeTab(page, server.url)

    await focusTerminalAndWatchHost(page)
    await evalInPage(page, pageId, `document.getElementById('probe').focus()`)

    const probeValue = (): Promise<unknown> =>
      evalInPage(page, pageId, `document.getElementById('probe').value`)
    await rpc(page, 'browser.keypress', { page: pageId, key: 'Z' })
    await rpc(page, 'browser.type', { page: pageId, input: 'qr' })
    await expect.poll(probeValue).toBe('Zqr')
    await rpc(page, 'browser.keypress', { page: pageId, key: 'Enter' })
    await rpc(page, 'browser.fill', { page: pageId, element: '#probe', value: 'filled' })
    await expect.poll(probeValue).toBe('filled')

    const host = await readHost(page)
    expect(host.log).toEqual([])
    expect(host.terminalFocused).toBe(true)
    await expect
      .poll(() =>
        evalInPage(
          page,
          pageId,
          `JSON.stringify({ submits: window.__submits, keys: window.__keys })`
        )
      )
      // Why: `type` presses real keys, so its characters log keydowns like the keypresses.
      .toBe(JSON.stringify({ submits: 1, keys: ['Z', 'q', 'r', 'Enter'] }))
    await afterAgentInput?.(pageId)
  } finally {
    await server.close()
  }
}

export async function runAgentClicksScenario(
  page: Page,
  afterAgentInput?: AfterAgentInput
): Promise<void> {
  const server = await startProbeServer()
  try {
    const pageId = await openBackgroundProbeTab(page, server.url)
    await focusTerminalAndWatchHost(page)
    const clicks = (): Promise<unknown> => evalInPage(page, pageId, 'window.__clicks')

    await rpc(page, 'browser.click', { page: pageId, element: '#target' })
    await expect.poll(clicks).toBe('1')
    expect((await readHost(page)).terminalFocused).toBe(true)

    await rpc(page, 'browser.mouseMove', { page: pageId, x: 100, y: 100 })
    await rpc(page, 'browser.mouseDown', { page: pageId, button: 'left' })
    await rpc(page, 'browser.mouseUp', { page: pageId, button: 'left' })
    await expect.poll(clicks).toBe('2')
    expect((await readHost(page)).terminalFocused).toBe(true)

    // Why: the page must still see the field the agent clicked as focused, or menus close on blur.
    await rpc(page, 'browser.click', { page: pageId, element: '#probe' })
    await expect
      .poll(() =>
        evalInPage(
          page,
          pageId,
          `JSON.stringify({ active: document.activeElement.id, focused: document.hasFocus(), blurs: window.__blurs })`
        )
      )
      .toBe(JSON.stringify({ active: 'probe', focused: true, blurs: 0 }))
    expect((await readHost(page)).terminalFocused).toBe(true)

    // Why: fill writes multiline values straight into the field, never through the user's focus.
    await rpc(page, 'browser.fill', { page: pageId, element: '#notes', value: 'a\nb' })
    await expect
      .poll(() => evalInPage(page, pageId, `document.getElementById('notes').value`))
      .toBe('a\nb')
    expect((await readHost(page)).terminalFocused).toBe(true)

    // Why: Tab from the page's last field moves focus out of the page into Orca's window.
    await evalInPage(page, pageId, `document.getElementById('notes').focus()`)
    await rpc(page, 'browser.keypress', { page: pageId, key: 'Tab' })
    await expect.poll(async () => (await readHost(page)).terminalFocused).toBe(true)

    // Why: the user's next keystroke is what the bug stole; it must reach the terminal, not the page.
    await page.keyboard.press('x')
    const host = await readHost(page)
    expect(host.log.filter((entry) => entry.startsWith('key:'))).toEqual(['key:x'])
    expect(host.terminalFocused).toBe(true)
    await expect
      .poll(() => evalInPage(page, pageId, 'JSON.stringify(window.__keys)'))
      .toBe('["Tab"]')
    await afterAgentInput?.(pageId)
  } finally {
    await server.close()
  }
}

export async function runAgentShortcutsScenario(
  page: Page,
  afterAgentInput?: AfterAgentInput
): Promise<void> {
  const server = await startProbeServer()
  try {
    const pageId = await openBackgroundProbeTab(page, server.url)
    await focusTerminalAndWatchHost(page)
    const activeTabBefore = await getActiveTabId(page)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

    // Why: new tab, close tab and next tab are Orca shortcuts; an agent's copies must not run them.
    for (const key of [`${mod}+t`, `${mod}+w`, 'Control+Tab']) {
      await rpc(page, 'browser.keypress', { page: pageId, key })
    }

    await expect.poll(() => evalInPage(page, pageId, 'window.__keys.length')).toBe('3')
    expect(await getActiveTabId(page)).toBe(activeTabBefore)
    const host = await readHost(page)
    expect(host.log.filter((entry) => entry.startsWith('key:'))).toEqual([])
    expect(host.terminalFocused).toBe(true)
    await afterAgentInput?.(pageId)
  } finally {
    await server.close()
  }
}

export async function runAgentCrossSiteFrameScenario(
  page: Page,
  afterAgentInput?: AfterAgentInput
): Promise<void> {
  const server = await startProbeServer()
  try {
    const pageId = await openBackgroundProbeTab(page, server.url)
    await focusTerminalAndWatchHost(page)
    await expect.poll(() => evalInPage(page, pageId, 'String(window.__frameReady)')).toBe('true')
    await evalInPage(page, pageId, `document.getElementById('frame').focus()`)
    await expect
      .poll(() => evalInPage(page, pageId, 'document.activeElement && document.activeElement.id'))
      .toBe('frame')
    const hostLogBeforeTyping = (await readHost(page)).log.length

    // Cross-site-frame input must use its own session without borrowing the user’s focus.
    await rpc(page, 'browser.keypress', { page: pageId, key: 'Z' })
    await expect
      .poll(() => evalInPage(page, pageId, 'JSON.stringify(window.__frameKeys)'))
      .toBe('["Z"]')
    await rpc(page, 'browser.type', { page: pageId, input: 'qr' })
    await expect.poll(() => evalInPage(page, pageId, 'window.__frameValue')).toContain('qr')

    const host = await readHost(page)
    expect(host.log.slice(hostLogBeforeTyping)).toEqual([])
    expect(host.terminalFocused).toBe(true)
    await afterAgentInput?.(pageId)
  } finally {
    await server.close()
  }
}
