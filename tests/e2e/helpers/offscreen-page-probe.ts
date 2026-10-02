/** The probe page and helpers the offscreen browser page e2e specs share. */

import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './store'

const PROBE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Offscreen probe</title>
    <style>
      html, body { margin: 0; font: 16px/1.4 sans-serif; }
      #field { position: absolute; left: 40px; top: 40px; width: 240px; height: 28px; }
      #button { position: absolute; left: 320px; top: 40px; }
      #choice { position: absolute; left: 40px; top: 110px; font-size: 16px; }
      #popup { position: absolute; left: 40px; top: 170px; }
      #scroller { position: absolute; left: 40px; top: 230px; width: 300px; height: 160px; overflow: auto; }
      #drag-source { position: absolute; left: 420px; top: 110px; width: 80px; height: 30px; background: #c33; }
      #drop-zone { position: absolute; left: 420px; top: 230px; width: 200px; height: 160px; background: #36c; }
      #scroller .filler { height: 4000px; }
      #fruit { position: absolute; left: 560px; top: 40px; width: 160px; }
      #frame { position: absolute; left: 40px; top: 420px; width: 200px; height: 80px; border: 0; }
    </style>
  </head>
  <body>
    <input id="field" aria-label="field" />
    <button id="button" title="Press me">button</button>
    <select id="choice" aria-label="choice">
      <option>alpha</option>
      <optgroup label="Later">
        <option>beta</option>
        <option disabled>gamma</option>
      </optgroup>
      <option>delta</option>
    </select>
    <a id="popup" href="/popup" target="_blank">open popup</a>
    <div id="scroller"><div class="filler">needle</div></div>
    <div id="drag-source" role="button" draggable="true" aria-label="drag source">drag</div>
    <div id="drop-zone" role="button" aria-label="drop zone"></div>
    <iframe id="frame" title="frame"></iframe>
    <input id="fruit" list="fruits" aria-label="fruit" />
    <datalist id="fruits">
      <option>apple</option>
      <option value="apricot">Apricot fruit</option>
      <option>banana</option>
    </datalist>
    <script>
      // Why localhost: a different site from 127.0.0.1, so the frame is out-of-process.
      if (location.search !== '?solo') {
        document.getElementById('frame').src = location.origin.replace('127.0.0.1', 'localhost') + '/frame'
      }
      window.__events = []
      window.__frame = null
      addEventListener('message', (event) => (window.__frame = event.data))
      const record = (event) => window.__events.push(event.type + ':' + event.isTrusted)
      document.getElementById('choice').addEventListener('change', record)
      document.getElementById('field').addEventListener('keydown', record)
      window.__drops = []
      document.getElementById('drag-source').addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', 'from-source')
      })
      const zone = document.getElementById('drop-zone')
      zone.addEventListener('dragover', (event) => event.preventDefault())
      zone.addEventListener('drop', (event) => {
        event.preventDefault()
        const files = [...event.dataTransfer.files].map((file) => file.name + ':' + file.size)
        window.__drops.push(files.length ? 'files:' + files.join(',') : 'text:' + event.dataTransfer.getData('text/plain'))
      })
    </script>
  </body>
</html>`

// Why postMessage: the frame is cross-site, so the page reads its state only from messages.
const FRAME_HTML = `<!doctype html>
<body style="margin:0">
  <div title="Inside frame" style="height:80px; width:90px">f</div>
  <input id="inner" style="position:absolute; left:100px; top:25px; width:90px" />
  <script>
    const inner = document.getElementById('inner')
    const tell = () => parent.postMessage(document.activeElement.id + ':' + inner.value, '*')
    inner.addEventListener('focus', tell)
    inner.addEventListener('input', tell)
    tell()
  </script>
</body>`

export async function startProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      request.url === '/popup'
        ? '<!doctype html><title>Offscreen popup</title>'
        : request.url === '/frame'
          ? FRAME_HTML
          : PROBE_HTML
    )
  })
  // Why no host: dual-stack, so the localhost frame loads whether it resolves to ::1 or 127.0.0.1.
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Probe server did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

type RuntimeResponse = { ok: boolean; result?: unknown; error?: unknown }

export async function rpc(
  page: Page,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response = await page.evaluate(
    ({ targetMethod, targetParams }) =>
      window.api.runtime.call({ method: targetMethod, params: targetParams }),
    { targetMethod: method, targetParams: params }
  )
  const typed: RuntimeResponse =
    response !== null && typeof response === 'object' && 'ok' in response
      ? {
          ok: response.ok === true,
          result: Reflect.get(response, 'result'),
          error: Reflect.get(response, 'error')
        }
      : { ok: false, error: response }
  expect(typed.ok, `${method} failed: ${JSON.stringify(typed.error)}`).toBe(true)
  return typed.result
}

export async function evalInPage(page: Page, pageId: string, expression: string): Promise<unknown> {
  const result = await rpc(page, 'browser.eval', { page: pageId, expression })
  const raw =
    result !== null && typeof result === 'object' && 'result' in result ? result.result : null
  // Why: browser.eval serializes its result; decode JSON-looking values back to JS.
  if (typeof raw !== 'string') {
    return raw
  }
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export async function openOffscreenTab(
  page: Page,
  url: string
): Promise<{ tabId: string; pageId: string; worktreeId: string }> {
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const worktreeId = await getActiveWorktreeId(page)
  expect(worktreeId).toBeTruthy()
  await page.evaluate(() =>
    window.__store?.getState().updateSettings({ experimentalOffscreenBrowserPages: true })
  )
  const created = await page.evaluate(
    ({ targetWorktreeId, targetUrl }) => {
      const tab = window.__store
        ?.getState()
        .createBrowserTab(targetWorktreeId, targetUrl, { title: 'Offscreen probe', activate: true })
      return tab ? { tabId: tab.id, pageId: tab.activePageId ?? null } : null
    },
    { targetWorktreeId: worktreeId!, targetUrl: url }
  )
  expect(created?.pageId).toBeTruthy()
  const pageId = created!.pageId!
  await expect(pageElement(page, pageId)).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(() => evalInPage(page, pageId, 'document.title'), { timeout: 20_000 })
    .toBe('Offscreen probe')
  // Why: input before the first frame is fine, but a painted canvas proves the texture path works.
  await expect
    .poll(() => pageElement(page, pageId).evaluate(canvasWidth), { timeout: 20_000 })
    .toBeGreaterThan(0)
  return { tabId: created!.tabId, pageId, worktreeId: worktreeId! }
}

export function pageElement(page: Page, pageId: string) {
  return page.locator(`orca-offscreen-page[data-browser-page-id="${pageId}"]`)
}

function canvasWidth(element: Element): number {
  return element.shadowRoot?.querySelector('canvas')?.width ?? 0
}

type Rect = { left: number; top: number; width: number; height: number }

/** Window-space rect of an element inside the page; page and host CSS px match at equal zoom. */
export async function rectOf(page: Page, pageId: string, selector: string): Promise<Rect> {
  const box = await pageElement(page, pageId).boundingBox()
  const inner = await evalInPage(
    page,
    pageId,
    `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`
  )
  if (!isRect(inner)) {
    throw new Error(`no rect for ${selector}: ${JSON.stringify(inner)}`)
  }
  return { ...inner, left: box!.x + inner.left, top: box!.y + inner.top }
}

function isRect(value: unknown): value is Rect {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['left', 'top', 'width', 'height'].every((key) => typeof Reflect.get(value, key) === 'number')
  )
}

/** A point just inside an element's left edge, clear of trailing icons like a select's arrow. */
export async function pointOf(page: Page, pageId: string, selector: string) {
  const rect = await rectOf(page, pageId, selector)
  return { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 }
}

export async function focusAddressBar(page: Page, pageId: string): Promise<void> {
  const url = String(await evalInPage(page, pageId, 'location.href'))
  await page.evaluate((expected) => {
    const input = [...document.querySelectorAll('input')].find((i) => i.value === expected)
    if (!input) {
      throw new Error('address bar not found')
    }
    input.focus()
    const log: string[] = []
    for (const type of ['blur', 'compositionupdate', 'compositionend']) {
      input.addEventListener(type, (event) =>
        log.push(`${type}:${event instanceof CompositionEvent ? event.data : ''}`)
      )
    }
    Object.assign(window, { __imeTarget: input, __imeLog: log })
  }, url)
}

export async function stubNativeMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const calls: unknown[] = []
    Object.assign(globalThis, { __offscreenMenuCalls: calls })
    Menu.prototype.popup = function popup(options) {
      calls.push({
        items: this.items.map((item) => ({
          label: item.label,
          enabled: item.enabled,
          checked: item.checked
        })),
        x: options?.x,
        y: options?.y,
        positioningItem: options?.positioningItem
      })
      Object.assign(globalThis, { __offscreenLastMenu: { menu: this, options } })
    }
  })
}
