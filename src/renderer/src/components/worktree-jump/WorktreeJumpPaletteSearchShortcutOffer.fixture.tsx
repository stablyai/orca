import { defineFixture } from '../../component-fixtures/component-fixture'
import { getLegacySearchBindings } from '../../../../shared/keybindings/definitions'
import type {
  KeybindingFileSnapshot,
  KeybindingPlatform
} from '../../../../shared/keybindings/types'
import { useAppStore } from '@/store'
import WorktreeJumpPalette from './WorktreeJumpPalette'

// An undecided existing profile: Search still on the legacy key, so the palette offers Mod+K.
function undecidedLegacyProfile(platform: KeybindingPlatform): KeybindingFileSnapshot {
  const legacyDefaults = getLegacySearchBindings(platform)
  return {
    path: '/preview/keybindings.json',
    platform,
    exists: false,
    overrides: legacyDefaults,
    defaultOverrides: legacyDefaults,
    commonOverrides: {},
    platformOverrides: {},
    diagnostics: [],
    searchShortcut: { choice: null }
  }
}

async function nextFrame(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve))
}

async function clickCardButton(doc: Document, name: string): Promise<void> {
  const button = [...doc.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find(
    (candidate) => candidate.textContent?.startsWith(name)
  )
  button?.click()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await nextFrame()
  }
}

// The palette portals out of the fixture frame, so narrow it directly to mimic a small window.
function offerCase({
  platform = 'darwin',
  dialogWidth,
  clicks = []
}: {
  platform?: KeybindingPlatform
  dialogWidth?: number
  clicks?: string[]
}) {
  return defineFixture({
    store: {
      activeModal: 'worktree-palette',
      keybindingSnapshot: undecidedLegacyProfile(platform)
    },
    setup: () =>
      useAppStore.setState((state) => ({
        // Bots need a paired runtime the fixture host lacks; the offer doesn't depend on them.
        settings: state.settings && { ...state.settings, botsEnabled: false },
        // No main process here: report each choice as saved without changing the snapshot.
        setSearchShortcutChoice: async () => 'applied'
      })),
    render: () => <WorktreeJumpPalette />,
    interact: async (frame) => {
      const doc = frame.ownerDocument
      for (let attempt = 0; attempt < 60 && !doc.querySelector('[role="dialog"]'); attempt += 1) {
        await nextFrame()
      }
      const dialog = doc.querySelector<HTMLElement>('[role="dialog"]')
      if (dialog && dialogWidth) {
        dialog.style.width = `${dialogWidth}px`
      }
      for (const name of clicks) {
        await clickCardButton(doc, name)
      }
    }
  })
}

export const wide = offerCase({})
// Below 500px the line wraps to two and the buttons take their own row; nothing truncates.
export const narrow = offerCase({ dialogWidth: 480 })
export const windowsNarrow = offerCase({ platform: 'win32', dialogWidth: 400 })
export const windowsWide = offerCase({ platform: 'win32' })
export const switched = offerCase({ clicks: ['Switch'] })
export const undone = offerCase({ clicks: ['Switch', 'Undo'] })
