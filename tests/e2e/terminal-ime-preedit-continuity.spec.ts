import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { setImeComposition } from './terminal-ime-cdp-composition'
import { writeToActiveTerminal } from './terminal-ime-midline-occlusion-probe'

test('keeps the CJK prefix in place across mixed text and the layout budget', async ({
  orcaPage
}, testInfo) => {
  const arena = await openTerminalImePaneArena(orcaPage)
  let completed = false
  try {
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const terminal = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal
      terminal.options.fontSize = 13
      terminal.options.fontFamily = 'monospace'
    })
    await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H')
    const prefix = 'あ'.repeat(32)
    let initial: number[] | undefined
    for (const suffix of [
      '',
      'a',
      '',
      '😀',
      'سلام',
      'क्षि',
      '  あ',
      ...[125, 126, 127, 128, 129, 130, 256].map((count) => 'aあ'.repeat(count)),
      `${'aあ'.repeat(256)}\u3099`,
      '',
      'a'
    ]) {
      await setImeComposition(arena.session, prefix + suffix)
      const preedit = orcaPage.locator('.composition-view.active .xterm-composition-preedit')
      await expect(preedit).toHaveText(`‎${prefix + suffix}‎`)
      const sample = await preedit.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const starts: number[] = []
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode()) && starts.length < 32) {
          const text = node.textContent ?? ''
          for (let offset = 0; offset < text.length && starts.length < 32; offset++) {
            if (text[offset] !== 'あ') {
              continue
            }
            const range = document.createRange()
            range.setStart(node, offset)
            range.setEnd(node, offset + 1)
            starts.push(range.getBoundingClientRect().left - bounds.left)
          }
        }
        const caret = element.parentElement!.querySelector('.xterm-composition-caret')!
        return {
          starts,
          width: bounds.width,
          caretRight: caret.getBoundingClientRect().right - bounds.left
        }
      })
      initial ??= sample.starts
      expect(sample.starts).toHaveLength(32)
      for (const [index, start] of sample.starts.entries()) {
        expect(start).toBeCloseTo(initial[index], 1)
      }
      expect(sample.caretRight).toBeCloseTo(sample.width, 1)
    }
    await setImeComposition(arena.session, '')
    completed = true
  } finally {
    await closeTerminalImePaneArena(arena, testInfo, 'preedit-continuity', !completed)
  }
})
