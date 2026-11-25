import { defineFixture } from '../../component-fixtures/component-fixture'
import { getLegacySearchBindings } from '../../../../shared/keybindings/definitions'
import type { KeybindingFileSnapshot } from '../../../../shared/keybindings/types'
import WorktreeJumpPalette from './WorktreeJumpPalette'

// An undecided existing macOS profile: Search still on Cmd+J, so the footer offers Cmd+K.
const legacyDefaults = getLegacySearchBindings('darwin')
const undecidedLegacyProfile: KeybindingFileSnapshot = {
  path: '/preview/keybindings.json',
  platform: 'darwin',
  exists: false,
  overrides: legacyDefaults,
  defaultOverrides: legacyDefaults,
  commonOverrides: {},
  platformOverrides: {},
  diagnostics: [],
  searchShortcut: { choice: null }
}

function offerCase(width: number) {
  return defineFixture({
    width,
    store: { activeModal: 'worktree-palette', keybindingSnapshot: undecidedLegacyProfile },
    render: () => <WorktreeJumpPalette />
  })
}

export const wide = offerCase(900)
// Narrow windows wrap the hints below the offer instead of clipping its terminal-clear warning.
export const narrow = offerCase(520)
