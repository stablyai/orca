import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { setImeComposition } from './terminal-ime-cdp-composition'
import { writeToActiveTerminal } from './terminal-ime-midline-occlusion-probe'

/** Every preedit code unit's left edge, then the preedit width, relative to the preedit. */
function measurePreeditEdges(): number[] {
  const preedit = document.querySelector<HTMLElement>(
    '.composition-view.active .xterm-composition-preedit'
  )!
  const bounds = preedit.getBoundingClientRect()
  const edges: number[] = []
  const walker = document.createTreeWalker(preedit, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let offset = 0; offset < node.textContent!.length; offset++) {
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      edges.push(range.getBoundingClientRect().left - bounds.left)
    }
  }
  return [...edges, bounds.width]
}

test('paints the selected clause in the theme selection colors without moving any cell', async ({
  orcaPage
}, testInfo) => {
  const arena = await openTerminalImePaneArena(orcaPage)
  let completed = false
  try {
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const terminal = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal
      terminal.options.theme = {
        ...terminal.options.theme,
        selectionBackground: '#7357d9',
        selectionForeground: '#ffffff'
      }
    })
    await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H')
    const text = '今日はいい天気です'
    await setImeComposition(arena.session, text)
    await expect(
      orcaPage.locator('.composition-view.active .xterm-composition-preedit')
    ).toHaveText(`‎${text}‎`)
    const unselected = await orcaPage.evaluate(measurePreeditEdges)

    await setImeComposition(arena.session, text, { start: 3, end: 9 })
    const clause = orcaPage.locator('.xterm-composition-preedit-selected')
    await expect(clause).toHaveText('いい天気です')
    await expect(clause).toHaveCSS('background-color', 'rgb(115, 87, 217)')
    await expect(clause).toHaveCSS('color', 'rgb(255, 255, 255)')
    const selected = await orcaPage.evaluate(measurePreeditEdges)
    // Chromium snaps each inline box the selection adds to 1/64px layout units.
    expect(selected).toHaveLength(unselected.length)
    selected.forEach((edge, index) => expect(edge).toBeCloseTo(unselected[index], 1))

    await setImeComposition(arena.session, '')
    completed = true
  } finally {
    await closeTerminalImePaneArena(arena, testInfo, 'ime-clause-selection', !completed)
  }
})
