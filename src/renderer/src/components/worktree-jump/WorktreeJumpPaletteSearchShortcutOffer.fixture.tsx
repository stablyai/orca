import { defineFixture } from '../../component-fixtures/component-fixture'
import { getLegacySearchBindings } from '../../../../shared/keybindings/definitions'
import type { KeybindingFileSnapshot } from '../../../../shared/keybindings/types'
import { useAppStore } from '@/store'
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

// The palette portals out of the fixture frame, so narrow it directly to mimic a small window.
function offerCase(dialogWidth?: number) {
  return defineFixture({
    store: { activeModal: 'worktree-palette', keybindingSnapshot: undecidedLegacyProfile },
    // Bots need a paired runtime the fixture host lacks; the footer offer doesn't depend on them.
    setup: () =>
      useAppStore.setState((state) => ({
        settings: state.settings && { ...state.settings, botsEnabled: false }
      })),
    render: () => <WorktreeJumpPalette />,
    interact: async (frame) => {
      const doc = frame.ownerDocument
      for (let attempt = 0; attempt < 60 && !doc.querySelector('[role="dialog"]'); attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      const dialog = doc.querySelector<HTMLElement>('[role="dialog"]')
      if (dialog && dialogWidth) {
        dialog.style.width = `${dialogWidth}px`
      }
    }
  })
}

export const wide = offerCase()
// Narrow windows wrap the hints below the offer instead of clipping its terminal-clear warning.
export const narrow = offerCase(480)
