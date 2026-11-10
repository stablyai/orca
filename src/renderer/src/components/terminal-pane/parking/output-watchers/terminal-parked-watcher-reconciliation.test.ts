import { afterEach, expect, it } from 'vitest'
import {
  captureParkedTerminalPaneCandidates,
  pruneParkedTerminalWatchers,
  retireParkedTerminalTab
} from './terminal-parked-watcher-registry'
import {
  readTerminalScrollIntentKeyRetention,
  writeKeyedTerminalScrollIntent
} from '../../../../lib/pane-manager/terminal-scroll-intent-key-store'

const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo::/worktree'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const FIRST_PTY_ID = 'remote:env-1@@terminal-1'

afterEach(() => {
  retireParkedTerminalTab(TAB_ID)
})

it('releases captured scroll-intent keys when a parked tab is closed', () => {
  writeKeyedTerminalScrollIntent(FIRST_LEAF_ID, {
    kind: 'pinnedViewport',
    bufferType: 'normal',
    viewportY: 4,
    baseY: 12,
    revision: 1
  })
  captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, [
    { ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true }
  ])

  expect(readTerminalScrollIntentKeyRetention().intents).toBe(1)
  retireParkedTerminalTab(TAB_ID)
  expect(readTerminalScrollIntentKeyRetention().intents).toBe(0)
})

it('releases captured scroll-intent keys when a parked worktree is removed', () => {
  writeKeyedTerminalScrollIntent(SECOND_LEAF_ID, {
    kind: 'pinnedViewport',
    bufferType: 'normal',
    viewportY: 8,
    baseY: 16,
    revision: 1
  })
  captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, [
    { ptyId: FIRST_PTY_ID, paneId: 1, leafId: SECOND_LEAF_ID, drivesTabTitle: true }
  ])

  pruneParkedTerminalWatchers(new Set())

  expect(readTerminalScrollIntentKeyRetention().intents).toBe(0)
})
