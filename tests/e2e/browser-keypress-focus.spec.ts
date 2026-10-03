import { createServer, type Server } from 'node:http'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'
import { focusActiveTerminalInput } from './helpers/terminal'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __hostKeys?: string[]
  }
}

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

const PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Keypress focus probe</title>
  </head>
  <body>
    <form id="form">
      <label>Query <input id="field" name="query" /></label>
    </form>
    <script>
      window.__submits = 0
      window.__bodyKeys = []
      document.getElementById('form').addEventListener('submit', (event) => {
        event.preventDefault()
        window.__submits += 1
      })
      document.addEventListener('keydown', (event) => {
        if (event.target === document.body) window.__bodyKeys.push(event.key)
      })
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
  return {
    url: `http://127.0.0.1:${address.port}/`,
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
        title: 'Keypress focus probe',
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
  const raw: unknown = await page.evaluate(
    ({ targetMethod, targetParams }) =>
      window.api.runtime.call({ method: targetMethod, params: targetParams }),
    { targetMethod: method, targetParams: params }
  )
  return {
    ok: readProperty(raw, 'ok') === true,
    result: readProperty(raw, 'result'),
    error: readProperty(raw, 'error')
  }
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

async function fieldRef(page: Page, pageId: string): Promise<string> {
  const snapshot = await expectOk(page, 'browser.snapshot', { page: pageId })
  const refs = readProperty(snapshot, 'refs')
  const ref =
    refs !== null && typeof refs === 'object'
      ? Object.entries(refs).find(([, entry]) => readProperty(entry, 'role') === 'textbox')?.[0]
      : undefined
  if (!ref) {
    throw new Error(`No textbox ref in snapshot: ${JSON.stringify(snapshot)}`)
  }
  return `@${ref}`
}

async function readHostKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__hostKeys ?? [])
}

async function recordHostKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const keys: string[] = []
    window.__hostKeys = keys
    document.addEventListener('keydown', (event) => keys.push(event.key), true)
  })
}

const readFieldState =
  'JSON.stringify({ value: document.getElementById("field").value, active: document.activeElement?.id, submits: window.__submits, bodyKeys: window.__bodyKeys })'

test('keypress reaches the field a prior focus or fill targeted @headful', async ({
  orcaPage,
  electronApp
}) => {
  const server = await startProbeServer()
  try {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).toBeTruthy()
    const pageId = await createBrowserTab(orcaPage, worktreeId!, server.url)
    await expect
      .poll(() => evaluateInPage(orcaPage, pageId, 'document.title'), { timeout: 20_000 })
      .toBe('Keypress focus probe')
    const element = await fieldRef(orcaPage, pageId)
    await recordHostKeys(orcaPage)
    const focusOrcaWindow = (): Promise<void> =>
      electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        win?.focus()
        win?.webContents.focus()
      })

    await expectOk(orcaPage, 'browser.fill', { page: pageId, element, value: 'orca' })
    await focusOrcaWindow()
    await expectOk(orcaPage, 'browser.keypress', { page: pageId, key: 'Enter' })
    await expect.poll(() => evaluateInPage(orcaPage, pageId, 'String(window.__submits)')).toBe('1')

    await expectOk(orcaPage, 'browser.focus', { page: pageId, element })
    await focusOrcaWindow()
    await expectOk(orcaPage, 'browser.keypress', { page: pageId, key: 'x' })
    await expectOk(orcaPage, 'browser.keypress', { page: pageId, key: 'Enter' })

    expect(await evaluateInPage(orcaPage, pageId, readFieldState)).toBe(
      JSON.stringify({ value: 'orcax', active: 'field', submits: 2, bodyKeys: [] })
    )
    expect(await readHostKeys(orcaPage)).toEqual([])
  } finally {
    await server.close()
  }
})

test('keypress from a focused terminal reaches a page in a background tab @headful', async ({
  orcaPage
}) => {
  const server = await startProbeServer()
  try {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).toBeTruthy()
    const pageId = await createBrowserTab(orcaPage, worktreeId!, server.url)
    await expect
      .poll(() => evaluateInPage(orcaPage, pageId, 'document.title'), { timeout: 20_000 })
      .toBe('Keypress focus probe')
    await focusActiveTerminalInput(orcaPage)
    await recordHostKeys(orcaPage)

    await expectOk(orcaPage, 'browser.keypress', { page: pageId, key: 'Escape' })

    expect(await evaluateInPage(orcaPage, pageId, 'JSON.stringify(window.__bodyKeys)')).toBe(
      JSON.stringify(['Escape'])
    )
    expect(await readHostKeys(orcaPage)).toEqual([])
  } finally {
    await server.close()
  }
})
