// Refuse agent presses and page focus moves during terminal IME composition: either ends the unfinished text (#28700, STA-15780).

import type { Page } from '@stablyai/playwright-test'
import '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  evalInPage,
  openBackgroundProbeTab,
  rpc,
  startProbeServer
} from './browser-agent-focus-scenarios'
import { getTerminalContent } from '../../terminal/layout/terminal-pane-identity'

async function readCompositionLog(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parsed: unknown = JSON.parse(document.documentElement.dataset.compositionProbeLog ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  })
}

export async function runAgentInputDuringUserCompositionScenario(page: Page): Promise<void> {
  const server = await startProbeServer()
  try {
    const pageId = await openBackgroundProbeTab(page, server.url)
    await page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      if (!textarea) {
        throw new Error('No terminal input to focus')
      }
      textarea.focus()
      const log: string[] = []
      const record = (entry: string): void => {
        log.push(entry)
        document.documentElement.dataset.compositionProbeLog = JSON.stringify(log)
      }
      for (const type of ['compositionend', 'blur']) {
        textarea.addEventListener(type, (event) =>
          record(event instanceof CompositionEvent ? `${type}:${event.data}` : type)
        )
      }
    })
    // Why: CDP enters Chromium where a real input method does: pinyin typed, no candidate picked.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })

    // Fill, eval and raw focus never borrow window focus, but their page focus move still discards the
    // composition on macOS.
    for (const [method, params] of [
      ['browser.click', { element: '#target' }],
      ['browser.fill', { element: '#probe', value: 'agent' }],
      ['browser.eval', { expression: 'document.getElementById("notes").focus()' }],
      ['browser.exec', { command: 'focus #notes' }]
    ] as const) {
      const refused: unknown = await page.evaluate(
        ({ id, m, p }) => window.api.runtime.call({ method: m, params: { page: id, ...p } }),
        { id: pageId, m: method, p: params }
      )
      expect(JSON.stringify(refused)).toContain('typing with an input method')
    }
    expect(await readCompositionLog(page)).toEqual([])

    await cdp.send('Input.insertText', { text: '中' })
    // Why after the commit: eval is refused while composing, and a refused input never runs later.
    expect(await evalInPage(page, pageId, 'window.__clicks')).toBe('0')
    expect(await evalInPage(page, pageId, 'document.getElementById("probe").value')).toBe('')
    expect(await evalInPage(page, pageId, 'document.activeElement?.id ?? ""')).not.toBe('notes')
    await rpc(page, 'browser.click', { page: pageId, element: '#target' })
    await expect.poll(() => evalInPage(page, pageId, 'window.__clicks')).toBe('1')
    expect((await readCompositionLog(page))[0]).toBe('compositionend:中')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
      .toContain('xterm-helper-textarea')
    // Why: a non-UTF-8 CI shell may not echo 中; a later ASCII key shows what reached it before.
    await page.keyboard.type('#28700')
    await expect.poll(() => getTerminalContent(page)).toContain('#28700')
    expect(await getTerminalContent(page)).not.toContain('zhong')
  } finally {
    await server.close()
  }
}
