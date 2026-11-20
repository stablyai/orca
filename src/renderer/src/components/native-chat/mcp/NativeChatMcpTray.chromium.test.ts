// Why Chromium: happy-dom has no layout, and the bug is the failed header's words clipping at 360px.
// Unit CI does not install Playwright browsers — probe once and skip when Chromium is unavailable.
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ensureFixtureServer,
  stopFixtureServer
} from '../../../../../../config/scripts/component-fixtures/fixture-server-client.mjs'

const browser: Browser | null = await chromium.launch({ headless: true }).catch(() => null)
let server: { url: string; started: boolean } | null = null

afterAll(async () => {
  await browser?.close()
  if (server?.started) {
    await stopFixtureServer()
  }
})

type HeaderGeometry = {
  row: { left: number; right: number; top: number; bottom: number }
  retry: { left: number; right: number; top: number; bottom: number }
  statusVisibleWidth: number
  clippedWidth: number
}

async function renderHeader(page: Page, fixture: string): Promise<HeaderGeometry> {
  server ??= await ensureFixtureServer()
  await page.goto(`${server.url}/fixtures.html?id=native-chat/mcp/NativeChatMcpTray:${fixture}`)
  await page.waitForFunction(() =>
    ['ready', 'error'].includes(document.documentElement.dataset.fixtureState ?? '')
  )
  expect(await page.getAttribute('html', 'data-fixture-state')).toBe('ready')
  return page.evaluate(() => {
    const text = document.querySelector('[data-native-chat-mcp-tray] p[aria-live]')
    const row = text?.parentElement
    const retry = row?.querySelector('button')
    const status = text?.lastElementChild
    if (!text || !row || !retry || !status) {
      throw new Error('MCP tray header did not render')
    }
    const box = text.getBoundingClientRect()
    const statusVisibleWidth = [...status.getClientRects()]
      .map((rect) => Math.min(rect.right, box.right) - Math.max(rect.left, box.left))
      .filter((width) => width > 0)
      .reduce((sum, width) => sum + width, 0)
    return {
      row: row.getBoundingClientRect().toJSON(),
      retry: retry.getBoundingClientRect().toJSON(),
      statusVisibleWidth,
      clippedWidth: text.scrollWidth - text.clientWidth
    }
  })
}

describe.skipIf(!browser)('MCP tray read-failed header in Chromium', () => {
  it.each([
    'readFailedNarrowEn',
    'readFailedNarrowDe',
    'readFailedNarrowRu',
    'readFailedNarrowLongEn',
    'readFailedNarrowLongDe',
    'readFailedNarrowLongRu'
  ])(
    '%s wraps its status instead of clipping it, with Retry in the row at 360px',
    async (fixture) => {
      if (!browser) {
        throw new Error('Chromium is unavailable')
      }
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      try {
        const header = await renderHeader(page, fixture)
        expect(header.statusVisibleWidth).toBeGreaterThan(0)
        expect(header.clippedWidth).toBe(0)
        expect(header.retry.left).toBeGreaterThanOrEqual(header.row.left)
        expect(header.retry.right).toBeLessThanOrEqual(header.row.right)
        expect(header.retry.top).toBeGreaterThanOrEqual(header.row.top)
        expect(header.retry.bottom).toBeLessThanOrEqual(header.row.bottom)
      } finally {
        await page.close()
      }
    },
    // A cold fixture server starts Vite and compiles the fixture page first.
    120_000
  )

  it(
    'keeps the one-line 32px header when the failure fits',
    async () => {
      if (!browser) {
        throw new Error('Chromium is unavailable')
      }
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      try {
        const header = await renderHeader(page, 'readFailed')
        expect(header.row.bottom - header.row.top).toBe(32)
      } finally {
        await page.close()
      }
    },
    // A cold fixture server starts Vite and compiles the fixture page first.
    120_000
  )
})
