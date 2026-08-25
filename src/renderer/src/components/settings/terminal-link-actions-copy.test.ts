import { describe, expect, it } from 'vitest'

import { getTerminalPaneInteractionSearchEntries } from './terminal-pane-appearance-search'
import {
  getTerminalFileLinkModifierDescription,
  getTerminalFileLinkModifierSearchKeywords,
  getTerminalFileLinkModifierTitle
} from './terminal-file-link-modifier-copy'
import {
  getTerminalLinkActionSearchKeywords,
  getTerminalLinkActionsDescription,
  getTerminalLinkActionsTitle
} from './terminal-link-actions-copy'

describe('terminal link actions copy', () => {
  it('names the platform modifier in the description', () => {
    expect(getTerminalLinkActionsDescription({ isMac: true })).toContain('⌘-click')

    const description = getTerminalLinkActionsDescription({ isMac: false })
    expect(description).toContain('Ctrl-click')
    expect(description).not.toContain('Cmd/Ctrl')
    // The copy is translated: a leaked `{{...}}` means the interpolation name drifted.
    expect(description).not.toMatch(/\{\{.+?\}\}/)
  })

  it('indexes both platform chords so either spelling finds the row', () => {
    expect(getTerminalLinkActionSearchKeywords({ isMac: true })).toEqual(
      expect.arrayContaining(['cmd', 'ctrl'])
    )
    expect(getTerminalLinkActionSearchKeywords({ isMac: false })).toEqual(
      expect.arrayContaining(['cmd', 'ctrl'])
    )
  })

  // Why: the row moved out of the Browser pane, so its search entry has to live in
  // the terminal catalog or it disappears whenever the settings search box is used.
  it('is indexed under Terminal Interaction', () => {
    const entry = getTerminalPaneInteractionSearchEntries().find(
      (candidate) => candidate.title === getTerminalLinkActionsTitle()
    )
    expect(entry).toBeDefined()
    expect(entry?.keywords).toContain('terminal')
  })
})

describe('terminal file-link modifier copy', () => {
  it('uses platform-specific shortcut copy', () => {
    expect(getTerminalFileLinkModifierDescription({ isMac: true })).toContain('⇧⌘+click')
    expect(getTerminalFileLinkModifierDescription({ isMac: false })).toContain('Shift+Ctrl+click')
  })

  it('indexes the visible row terms and both platform modifiers', () => {
    const keywords = getTerminalFileLinkModifierSearchKeywords({ isMac: true })
    expect(keywords).toEqual(
      expect.arrayContaining(['invert', 'swap', 'default app', 'finder', 'cmd', 'ctrl'])
    )

    const entry = getTerminalPaneInteractionSearchEntries().find(
      (candidate) => candidate.title === getTerminalFileLinkModifierTitle()
    )
    expect(entry?.keywords).toEqual(expect.arrayContaining(keywords))
  })
})
