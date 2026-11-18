import type { Page } from '@stablyai/playwright-test'

/** Focuses the terminal and records every host keydown and focus move from here on. */
export async function focusTerminalAndWatchHost(page: Page): Promise<void> {
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
