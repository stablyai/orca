/**
 * E2E coverage for experimental offscreen browser pages.
 *
 * The point of the feature is that nothing an agent does to a page can move Orca's focus or break
 * an IME composition the user has open elsewhere, while the user can still use the page directly.
 * Each test drives the real input paths: Playwright's CDP input into Orca's hidden window for the
 * user, and runtime RPCs for the agent.
 */

import { rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

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

async function startProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
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

async function rpc(page: Page, method: string, params: Record<string, unknown>): Promise<unknown> {
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

async function evalInPage(page: Page, pageId: string, expression: string): Promise<unknown> {
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

async function openOffscreenTab(
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

function pageElement(page: Page, pageId: string) {
  return page.locator(`orca-offscreen-page[data-browser-page-id="${pageId}"]`)
}

function canvasWidth(element: Element): number {
  return element.shadowRoot?.querySelector('canvas')?.width ?? 0
}

type Rect = { left: number; top: number; width: number; height: number }

/** Window-space rect of an element inside the page; page and host CSS px match at equal zoom. */
async function rectOf(page: Page, pageId: string, selector: string): Promise<Rect> {
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
async function pointOf(page: Page, pageId: string, selector: string) {
  const rect = await rectOf(page, pageId, selector)
  return { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 }
}

async function focusAddressBar(page: Page, pageId: string): Promise<void> {
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

async function stubNativeMenus(app: ElectronApplication): Promise<void> {
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

test.describe('offscreen browser pages', () => {
  let server: { url: string; close: () => Promise<void> }

  test.beforeEach(async () => {
    server = await startProbeServer()
  })
  test.afterEach(async () => {
    await server.close()
  })

  test('agent input never takes focus from an IME composition in Orca', async ({ orcaPage }) => {
    const { pageId } = await openOffscreenTab(orcaPage, server.url)
    await focusAddressBar(orcaPage, pageId)
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })

    const snapshot = await rpc(orcaPage, 'browser.snapshot', { page: pageId })
    const text = String(
      snapshot !== null && typeof snapshot === 'object' && 'snapshot' in snapshot
        ? snapshot.snapshot
        : ''
    )
    const ref = (label: string) =>
      text
        .split('\n')
        .find((line) => line.includes(label))
        ?.match(/ref=(e\d+)/)?.[1]
    await rpc(orcaPage, 'browser.click', { page: pageId, element: `@${ref('textbox "field"')}` })
    await rpc(orcaPage, 'browser.type', { page: pageId, input: 'agent-typed' })
    await rpc(orcaPage, 'browser.click', { page: pageId, element: `@${ref('button "button"')}` })
    await rpc(orcaPage, 'browser.keypress', { page: pageId, key: 'Tab' })

    await cdp.send('Input.imeSetComposition', { text: 'nih', selectionStart: 3, selectionEnd: 3 })
    await cdp.send('Input.insertText', { text: '你好' })
    const after = await orcaPage.evaluate(() => {
      const target = Reflect.get(window, '__imeTarget')
      return {
        stillFocused: document.activeElement === target,
        // The address bar is a controlled input, so the committed text lands after its URL.
        endsWithComposition: target instanceof HTMLInputElement && target.value.endsWith('你好'),
        log: Reflect.get(window, '__imeLog')
      }
    })
    expect(after).toEqual({
      stillFocused: true,
      endsWithComposition: true,
      log: [
        'compositionupdate:ni',
        'compositionupdate:nih',
        'compositionupdate:你好',
        'compositionend:你好'
      ]
    })
    expect(await evalInPage(orcaPage, pageId, 'document.getElementById("field").value')).toBe(
      'agent-typed'
    )
  })

  test('the user can click, type, compose and scroll inside the page', async ({ orcaPage }) => {
    const { pageId } = await openOffscreenTab(orcaPage, server.url)
    const field = await pointOf(orcaPage, pageId, '#field')
    await orcaPage.mouse.click(field.x, field.y)
    await expect.poll(() => evalInPage(orcaPage, pageId, 'document.activeElement.id')).toBe('field')
    expect(
      await orcaPage.evaluate(
        () => document.activeElement?.shadowRoot?.activeElement?.tagName ?? null
      )
    ).toBe('TEXTAREA')

    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    await orcaPage.keyboard.type('ab')
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'document.getElementById("field").value'))
      .toBe('abzhong')
    await cdp.send('Input.insertText', { text: '中' })
    await orcaPage.keyboard.press('Backspace')
    await orcaPage.keyboard.type('文')
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'document.getElementById("field").value'))
      .toBe('ab文')
    expect(
      await evalInPage(orcaPage, pageId, 'window.__events.every((e) => e.endsWith(":true"))')
    ).toBe(true)

    const scroller = await pointOf(orcaPage, pageId, '#scroller')
    await orcaPage.mouse.move(scroller.x + 40, scroller.y)
    await orcaPage.mouse.wheel(0, 200)
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'document.getElementById("scroller").scrollTop'))
      .toBeGreaterThan(0)
  })

  test('select menus open as native menus and apply the choice', async ({
    orcaPage,
    electronApp
  }) => {
    const { pageId } = await openOffscreenTab(orcaPage, server.url)
    await stubNativeMenus(electronApp)
    const choice = await pointOf(orcaPage, pageId, '#choice')
    const choiceRect = await rectOf(orcaPage, pageId, '#choice')
    const menuCalls = () =>
      electronApp.evaluate(() => Reflect.get(globalThis, '__offscreenMenuCalls') ?? [])

    await orcaPage.mouse.click(choice.x, choice.y)
    await expect.poll(async () => (await menuCalls()).length).toBe(1)
    const [call] = await menuCalls()
    expect(call).toMatchObject({
      items: [
        { label: 'alpha', enabled: true, checked: true },
        { label: 'Later', enabled: false },
        { label: 'beta', enabled: true, checked: false },
        { label: 'gamma', enabled: false },
        { label: 'delta', enabled: true, checked: false }
      ],
      positioningItem: 0
    })
    // The menu opens on the select, in window coordinates (UI zoom is 100% here).
    expect(Math.abs(call.x - choiceRect.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(call.y - choiceRect.top)).toBeLessThanOrEqual(1)

    await electronApp.evaluate(() => {
      const last = Reflect.get(globalThis, '__offscreenLastMenu')
      last.menu.items[4].click()
      last.options.callback()
    })
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'document.getElementById("choice").value'))
      .toBe('delta')
    await expect
      .poll(() =>
        evalInPage(orcaPage, pageId, 'document.getElementById("choice").matches(":open")')
      )
      .toBe(false)
    expect(await evalInPage(orcaPage, pageId, 'window.__events.includes("change:false")')).toBe(
      true
    )

    // Dismissing without a choice must also leave the select ready to open again.
    await orcaPage.mouse.click(choice.x, choice.y)
    await expect.poll(async () => (await menuCalls()).length).toBe(2)
    await electronApp.evaluate(() =>
      Reflect.get(globalThis, '__offscreenLastMenu').options.callback()
    )
    await expect
      .poll(() =>
        evalInPage(orcaPage, pageId, 'document.getElementById("choice").matches(":open")')
      )
      .toBe(false)
    await orcaPage.mouse.click(choice.x, choice.y)
    await expect.poll(async () => (await menuCalls()).length).toBe(3)
    expect((await menuCalls())[2]).toMatchObject({ positioningItem: 4 })
    await electronApp.evaluate(() =>
      Reflect.get(globalThis, '__offscreenLastMenu').options.callback()
    )
  })

  test('find, zoom, links, context menu and teardown match a webview', async ({
    orcaPage,
    electronApp
  }) => {
    const { tabId, pageId, worktreeId } = await openOffscreenTab(orcaPage, server.url)

    const found = await pageElement(orcaPage, pageId).evaluate(
      (element) =>
        new Promise((resolve) => {
          element.addEventListener('found-in-page', (event) =>
            resolve(Reflect.get(event, 'result'))
          )
          Reflect.get(element, 'findInPage').call(element, 'needle')
        })
    )
    expect(found).toMatchObject({ matches: 1, activeMatchOrdinal: 1 })

    // UI zoom: the page adopts Orca's zoom so it renders at the host's pixel ratio.
    await orcaPage.evaluate(() => window.api.ui.setZoomLevel(1))
    await expect
      .poll(async () => {
        const hostRatio = await orcaPage.evaluate(() => devicePixelRatio)
        const pageRatio = Number(await evalInPage(orcaPage, pageId, 'devicePixelRatio'))
        return Math.abs(hostRatio - pageRatio) < 0.01
      })
      .toBe(true)
    const field = await pointOf(orcaPage, pageId, '#field')
    await orcaPage.mouse.click(field.x, field.y)
    await expect.poll(() => evalInPage(orcaPage, pageId, 'document.activeElement.id')).toBe('field')
    await orcaPage.evaluate(() => window.api.ui.setZoomLevel(0))

    // target=_blank opens another offscreen tab, as a webview's popup does.
    const popupLink = await pointOf(orcaPage, pageId, '#popup')
    await orcaPage.mouse.click(popupLink.x, popupLink.y)
    await expect
      .poll(() => orcaPage.evaluate(() => document.querySelectorAll('orca-offscreen-page').length))
      .toBe(2)

    // Right-click asks the pane for its context menu.
    await orcaPage.evaluate((id) => {
      window.__store?.getState().setActiveBrowserTab(id)
    }, tabId)
    await expect(pageElement(orcaPage, pageId)).toBeVisible()
    const button = await pointOf(orcaPage, pageId, '#button')
    await orcaPage.mouse.click(button.x, button.y, { button: 'right' })
    await expect(orcaPage.getByRole('menuitem', { name: 'Inspect Page' })).toBeVisible()
    await orcaPage.keyboard.press('Escape')

    // Agents keep working on a tab that is not shown.
    await orcaPage.evaluate(
      ({ targetWorktreeId }) => {
        window.__store
          ?.getState()
          .createBrowserTab(targetWorktreeId, 'about:blank', { title: 'Other', activate: true })
      },
      { targetWorktreeId: worktreeId }
    )
    await expect(pageElement(orcaPage, pageId)).toBeHidden()
    const shot = await rpc(orcaPage, 'browser.screenshot', { page: pageId })
    expect(JSON.stringify(shot).length).toBeGreaterThan(1000)
    expect(await evalInPage(orcaPage, pageId, 'document.title')).toBe('Offscreen probe')

    // Closing the tab destroys the offscreen page in main.
    const guestId = await pageElement(orcaPage, pageId).evaluate((element) =>
      Reflect.get(element, 'getWebContentsId').call(element)
    )
    await orcaPage.evaluate((id) => window.__store?.getState().closeBrowserTab(id), tabId)
    await expect
      .poll(() =>
        electronApp.evaluate(({ webContents }, id) => {
          const contents = webContents.fromId(id)
          return !contents || contents.isDestroyed()
        }, guestId)
      )
      .toBe(true)
  })
  test('drag and drop works for the user, an agent, and files from the OS', async ({
    orcaPage
  }) => {
    const { pageId } = await openOffscreenTab(orcaPage, server.url)
    const drops = () => evalInPage(orcaPage, pageId, 'window.__drops')

    // The user drags inside the page.
    const source = await pointOf(orcaPage, pageId, '#drag-source')
    const zone = await pointOf(orcaPage, pageId, '#drop-zone')
    await orcaPage.mouse.move(source.x, source.y)
    await orcaPage.mouse.down()
    for (let step = 1; step <= 12; step++) {
      await orcaPage.mouse.move(
        source.x + ((zone.x - source.x) * step) / 12,
        source.y + ((zone.y + 30 - source.y) * step) / 12
      )
    }
    await orcaPage.mouse.up()
    await expect.poll(drops).toEqual(['text:from-source'])

    // An agent drags with its own command.
    const snapshot = await rpc(orcaPage, 'browser.snapshot', { page: pageId })
    const text = String(Reflect.get(Object(snapshot), 'snapshot') ?? '')
    const ref = (label: string) =>
      text
        .split('\n')
        .find((line) => line.includes(label))
        ?.match(/ref=(e\d+)/)?.[1]
    await rpc(orcaPage, 'browser.drag', {
      page: pageId,
      from: `@${ref('button "drag source"')}`,
      to: `@${ref('button "drop zone"')}`
    })
    await expect.poll(drops).toEqual(['text:from-source', 'text:from-source'])

    // A file dragged in from the OS: CDP drives a real drag into Orca's own window.
    const filePath = path.join(os.tmpdir(), `orca-offscreen-drop-${Date.now()}.txt`)
    writeFileSync(filePath, 'dropped!')
    try {
      const cdp = await orcaPage.context().newCDPSession(orcaPage)
      const data = { items: [], files: [filePath], dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await cdp.send('Input.dispatchDragEvent', { type, x: zone.x, y: zone.y + 30, data })
      }
      await expect
        .poll(drops)
        .toEqual(['text:from-source', 'text:from-source', `files:${path.basename(filePath)}:8`])
    } finally {
      rmSync(filePath, { force: true })
    }
  })

  test('an agent drives a hidden page without frame-rate stalls', async ({ orcaPage }) => {
    const { pageId, worktreeId } = await openOffscreenTab(orcaPage, server.url)
    await orcaPage.evaluate(
      ({ targetWorktreeId }) => {
        window.__store
          ?.getState()
          .createBrowserTab(targetWorktreeId, 'about:blank', { title: 'Other', activate: true })
      },
      { targetWorktreeId: worktreeId }
    )
    await expect(pageElement(orcaPage, pageId)).toBeHidden()
    const elapsed = await orcaPage.evaluate(async (targetPage) => {
      const call = (method: string, params: Record<string, unknown>) =>
        window.api.runtime.call({ method, params: { page: targetPage, ...params } })
      const samples: number[] = []
      for (let index = 0; index < 20; index++) {
        const started = performance.now()
        await call('browser.mouseMove', { x: 60 + index, y: 50 })
        samples.push(performance.now() - started)
      }
      return samples
    }, pageId)
    // Why skip the first: it may wait one idle-rate frame before the input boost applies.
    const warm = elapsed.slice(1)
    const average = warm.reduce((sum, value) => sum + value, 0) / warm.length
    expect(average, JSON.stringify(elapsed)).toBeLessThan(40)
    expect(elapsed[0], JSON.stringify(elapsed)).toBeLessThan(250)
  })

  test('a page that dies under a live tab recovers', async ({ orcaPage, electronApp }) => {
    // Why solo: Playwright drops its whole connection when a page with an out-of-process frame
    // crashes; the app itself survives that (checked without Playwright).
    const { pageId } = await openOffscreenTab(orcaPage, `${server.url}?solo`)
    const guestId = () =>
      pageElement(orcaPage, pageId).evaluate((element) => {
        try {
          return Number(Reflect.get(element, 'getWebContentsId').call(element))
        } catch {
          return null
        }
      })

    // Renderer crash: the page reports it, and reload brings it back.
    const firstId = await guestId()
    await electronApp.evaluate(({ webContents }, id) => {
      webContents.fromId(id)?.forcefullyCrashRenderer()
    }, firstId!)
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'document.title').catch(() => null), {
        timeout: 30_000
      })
      .toBe('Offscreen probe')

    // WebContents destroyed outright: the pane rebuilds the page.
    const beforeDestroy = await guestId()
    // The page's hidden host window closing takes the page with it.
    await electronApp.evaluate(({ BaseWindow, WebContentsView }, id) => {
      const host = BaseWindow.getAllWindows().find((window) =>
        window.contentView.children.some(
          (view) => view instanceof WebContentsView && view.webContents.id === id
        )
      )
      host?.destroy()
    }, beforeDestroy!)
    await expect
      .poll(
        async () => {
          const id = await guestId()
          return id !== null && id !== beforeDestroy
        },
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'document.title').catch(() => null), {
        timeout: 30_000
      })
      .toBe('Offscreen probe')
  })
  test('page tooltips show on the page, from any frame', async ({ orcaPage }) => {
    const { pageId } = await openOffscreenTab(orcaPage, server.url)
    const title = () =>
      pageElement(orcaPage, pageId).evaluate(
        (element) => element.shadowRoot?.querySelector('canvas')?.getAttribute('title') ?? null
      )
    const hover = async (selector: string) => {
      const point = await pointOf(orcaPage, pageId, selector)
      await orcaPage.mouse.move(point.x, point.y)
      await orcaPage.mouse.move(point.x + 1, point.y)
    }
    await hover('#button')
    await expect.poll(title).toBe('Press me')
    // The frame reports once it has loaded.
    await expect.poll(() => evalInPage(orcaPage, pageId, 'window.__frame')).toBe(':')
    await hover('#frame')
    await expect.poll(title).toBe('Inside frame')
    await hover('#field')
    await expect.poll(title).toBeNull()
  })

  test('clicks and keys reach a cross-site frame, from the user and an agent', async ({
    orcaPage
  }) => {
    const { pageId } = await openOffscreenTab(orcaPage, server.url)
    const frameState = () => evalInPage(orcaPage, pageId, 'window.__frame')
    // The frame reports once it has loaded, with nothing focused.
    await expect.poll(frameState).toBe(':')
    const rect = await evalInPage(
      orcaPage,
      pageId,
      'JSON.stringify(document.getElementById("frame").getBoundingClientRect())'
    )
    const left = Number(Reflect.get(Object(rect), 'left'))
    const top = Number(Reflect.get(Object(rect), 'top'))
    await rpc(orcaPage, 'browser.mouseClick', { page: pageId, x: left + 145, y: top + 35 })
    await expect.poll(frameState).toBe('inner:')

    const field = await pointOf(orcaPage, pageId, '#field')
    await orcaPage.mouse.click(field.x, field.y)
    await expect.poll(() => evalInPage(orcaPage, pageId, 'document.activeElement.id')).toBe('field')
    const frame = await rectOf(orcaPage, pageId, '#frame')
    // The frame's input spans x 100 to 190 from y 25, in the frame's own px.
    await orcaPage.mouse.click(frame.left + 145, frame.top + 35)
    await orcaPage.keyboard.type('hi')
    await expect.poll(frameState).toBe('inner:hi')
  })

  test('datalist suggestions show over the page and take keys', async ({ orcaPage }) => {
    const { pageId } = await openOffscreenTab(orcaPage, server.url)
    const popup = pageElement(orcaPage, pageId).locator('.datalist')
    const rows = popup.locator('.datalist-row')
    const selectedRow = () =>
      rows.evaluateAll((elements) =>
        elements.findIndex((row) => getComputedStyle(row).backgroundColor !== 'rgba(0, 0, 0, 0)')
      )
    const fruit = await pointOf(orcaPage, pageId, '#fruit')
    await orcaPage.mouse.click(fruit.x, fruit.y)
    await orcaPage.mouse.click(fruit.x, fruit.y)
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(1)).toContainText('Apricot fruit')
    // Drawn where the page put its popup: just under the field.
    const box = await popup.boundingBox()
    expect(Math.abs((box?.y ?? 0) - (fruit.y + 10))).toBeLessThan(20)

    await orcaPage.keyboard.press('ArrowDown')
    await orcaPage.keyboard.press('ArrowDown')
    await expect.poll(selectedRow).toBe(1)
    await orcaPage.keyboard.press('Enter')
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'document.getElementById("fruit").value'))
      .toBe('apricot')
    await expect(popup).toBeHidden()

    // Typing narrows the list; Escape closes it and keeps the text.
    await evalInPage(orcaPage, pageId, 'document.getElementById("fruit").value = ""; true')
    await orcaPage.keyboard.type('ban')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('banana')
    await orcaPage.keyboard.press('Escape')
    await expect(popup).toBeHidden()
    expect(await evalInPage(orcaPage, pageId, 'document.getElementById("fruit").value')).toBe('ban')
  })

  test('browser shortcuts typed inside the page act on the page', async ({
    orcaPage,
    electronApp
  }) => {
    const { tabId, pageId, worktreeId } = await openOffscreenTab(orcaPage, server.url)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const focusField = async () => {
      const field = await pointOf(orcaPage, pageId, '#field')
      await orcaPage.mouse.click(field.x, field.y)
      await expect
        .poll(() => evalInPage(orcaPage, pageId, 'document.activeElement.id'))
        .toBe('field')
    }
    const addressBar = orcaPage
      .locator(`[data-browser-overlay-tab-id="${tabId}"]`)
      .locator('[data-orca-browser-address-bar="true"]')

    // Copy and paste go through the app menu, the way Cmd/Ctrl+C and +V reach Orca.
    const savedClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
    const clickEditMenuItem = (label: string) =>
      electronApp.evaluate(({ BrowserWindow, Menu }, itemLabel) => {
        // Why: the hidden test window is never the OS-focused window; the menu routes by it.
        const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isOffscreen())
        const original = BrowserWindow.getFocusedWindow
        BrowserWindow.getFocusedWindow = () => main ?? null
        try {
          const edit = Menu.getApplicationMenu()?.items.find(
            (item) => item.role === 'editMenu' || item.label === 'Edit'
          )
          const item = edit?.submenu?.items.find((entry) => entry.label === itemLabel)
          if (!item) {
            throw new Error(`Edit menu item ${itemLabel} not found`)
          }
          item.click()
        } finally {
          BrowserWindow.getFocusedWindow = original
        }
      }, label)
    try {
      await focusField()
      await orcaPage.keyboard.type('copy me')
      await clickEditMenuItem('Select All')
      await clickEditMenuItem('Copy')
      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe('copy me')
      await electronApp.evaluate(({ clipboard }) => clipboard.writeText(' pasted'))
      await orcaPage.keyboard.press('End')
      await clickEditMenuItem('Paste')
      await expect
        .poll(() => evalInPage(orcaPage, pageId, 'document.getElementById("field").value'))
        .toBe('copy me pasted')

      // The same edits typed as chords, which never touch the empty IME textarea.
      await orcaPage.keyboard.press(`${mod}+a`)
      await orcaPage.keyboard.press(`${mod}+x`)
      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe('copy me pasted')
      await expect
        .poll(() => evalInPage(orcaPage, pageId, 'document.getElementById("field").value'))
        .toBe('')
      await orcaPage.keyboard.press(`${mod}+v`)
      await orcaPage.keyboard.press(`${mod}+v`)
      await expect
        .poll(() => evalInPage(orcaPage, pageId, 'document.getElementById("field").value'))
        .toBe('copy me pastedcopy me pasted')
      await orcaPage.keyboard.press(`${mod}+a`)
      await orcaPage.keyboard.press('Backspace')
    } finally {
      await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)
    }

    // Why sendInputEvent: Playwright's CDP keys skip before-input-event, where real keys meet
    // Orca's window shortcut routing.
    const chord = (keyCode: string) =>
      electronApp.evaluate(
        ({ BrowserWindow }, { key, darwin }) => {
          const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isOffscreen())
          if (!main) {
            throw new Error('Orca window not found')
          }
          const modifiers: ('meta' | 'control')[] = [darwin ? 'meta' : 'control']
          main.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
          main.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
        },
        { key: keyCode, darwin: process.platform === 'darwin' }
      )
    // Focus address bar.
    await chord('l')
    await expect(addressBar).toBeFocused()

    // Find in page.
    await focusField()
    await chord('f')
    const findInput = orcaPage.getByPlaceholder('Find in page...')
    await expect(findInput).toBeFocused()
    await orcaPage.keyboard.press('Escape')
    await expect(findInput).toBeHidden()

    // Reload.
    await evalInPage(orcaPage, pageId, 'window.__marker = "before-reload"')
    await focusField()
    await chord('r')
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'String(window.__marker)'))
      .toBe('undefined')

    // Zoom in and back to 100%, by chord and by ctrl+wheel; Orca's own zoom stays put.
    const pageZoom = () =>
      pageElement(orcaPage, pageId).evaluate((element) =>
        Reflect.get(element, 'getZoomLevel').call(element)
      )
    const uiZoom = () =>
      electronApp.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isOffscreen())
        if (!main) {
          throw new Error('Orca window not found')
        }
        return main.webContents.getZoomLevel()
      })
    const uiZoomBefore = await uiZoom()
    await focusField()
    await chord('=')
    await expect.poll(pageZoom).toBeGreaterThan(0)
    await chord('0')
    await expect.poll(pageZoom).toBe(0)
    const field = await pointOf(orcaPage, pageId, '#field')
    await orcaPage.mouse.move(field.x, field.y)
    await orcaPage.keyboard.down('Control')
    await orcaPage.mouse.wheel(0, -100)
    await orcaPage.keyboard.up('Control')
    await expect.poll(pageZoom).toBeGreaterThan(0)
    await chord('0')
    await expect.poll(pageZoom).toBe(0)
    expect(await uiZoom()).toBe(uiZoomBefore)

    // Once focus leaves the page, zoom chords zoom Orca again.
    await addressBar.focus()
    await chord('=')
    await expect.poll(uiZoom).not.toBe(uiZoomBefore)
    // A page follows Orca's zoom as a <webview> does, but takes no page step of its own.
    await expect.poll(pageZoom).toBe(await uiZoom())
    await chord('0')
    await expect.poll(uiZoom).toBe(uiZoomBefore)

    // Switching tabs away from a focused page does too.
    await focusField()
    const otherTabId = await orcaPage.evaluate(
      (targetWorktreeId) =>
        window.__store
          ?.getState()
          .createBrowserTab(targetWorktreeId, 'about:blank', { title: 'Other', activate: true }).id,
      worktreeId
    )
    await chord('=')
    await expect.poll(uiZoom).not.toBe(uiZoomBefore)
    await chord('0')
    await expect.poll(uiZoom).toBe(uiZoomBefore)
    await orcaPage.evaluate(
      ([other, original]) => {
        const state = window.__store?.getState()
        if (other) {
          state?.closeBrowserTab(other)
        }
        state?.setActiveBrowserTab(original)
      },
      [otherTabId, tabId] as const
    )

    // Back.
    await evalInPage(orcaPage, pageId, 'location.href = "/?second"')
    await expect.poll(() => evalInPage(orcaPage, pageId, 'location.search')).toBe('?second')
    await focusField()
    await electronApp.evaluate(({ BrowserWindow }, darwin) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isOffscreen())
      if (!main) {
        throw new Error('Orca window not found')
      }
      const keyCode = darwin ? '[' : 'Left'
      const modifiers: ('meta' | 'alt')[] = [darwin ? 'meta' : 'alt']
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }, process.platform === 'darwin')
    await expect.poll(() => evalInPage(orcaPage, pageId, 'location.search')).toBe('')
  })
})
