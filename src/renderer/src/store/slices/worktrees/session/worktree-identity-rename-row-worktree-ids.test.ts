/**
 * Rename has to re-point the maps that name their worktree in the VALUE, not the key.
 *
 * `WORKTREE_ID_KEYED_MAP_KEYS` covers the `*ByWorktree` maps, and the rename path deliberately
 * skips tab- and file-keyed ones because those ids survive a rename. Two of the skipped maps carry
 * the worktree id inside each row, and a stale one there is not residue — it is a suppression that
 * silently stops matching:
 *
 *  - `closedTerminalTabTombstonesByTabId`: the remote merge only suppresses a host tab when the
 *    tombstone's worktree equals the tab's, so a tombstone left on the old id re-admits a terminal
 *    tab the user closed, and never gets acknowledged because no snapshot covers the old id.
 *  - `clientHostedBrowserCloseIntentsByEnvironment`: the replay targets `intent.worktreeId`, and an
 *    unresolvable selector answers `selector_not_found` — a code the replay reads as "definitively
 *    gone" and uses to DROP the intent, leaving the page the user closed open forever.
 *
 * Main-process counterpart: worktree-identity-migration-field-coverage.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { buildWorktreeRenameState } from './worktree-identity-rename-state'

const OLD = 'repo1::/ws/old'
const NEW = 'repo1::/ws/new'
const OTHER = 'repo1::/ws/other'

function appState(overrides: Partial<AppState>): AppState {
  return {
    lastVisitedAtByWorktreeId: {},
    everActivatedWorktreeIds: new Set<string>(),
    closedTerminalTabTombstonesByTabId: {},
    clientHostedBrowserCloseIntentsByEnvironment: {},
    ...overrides
  } as unknown as AppState
}

describe('buildWorktreeRenameState value-owned worktree rows', () => {
  it('re-points a closed-terminal-tab tombstone onto the new worktree id', () => {
    const next = buildWorktreeRenameState(
      appState({
        closedTerminalTabTombstonesByTabId: {
          'tab-1': { closedAt: 5, worktreeId: OLD, ackRevision: 3 },
          'tab-2': { closedAt: 6, worktreeId: OTHER }
        }
      }),
      OLD,
      NEW
    )
    expect(next.closedTerminalTabTombstonesByTabId).toEqual({
      'tab-1': { closedAt: 5, worktreeId: NEW, ackRevision: 3 },
      'tab-2': { closedAt: 6, worktreeId: OTHER }
    })
  })

  it('re-points a client-hosted browser close intent onto the new worktree id', () => {
    const next = buildWorktreeRenameState(
      appState({
        clientHostedBrowserCloseIntentsByEnvironment: {
          'env-1': [
            { browserPageId: 'page-1', worktreeId: OLD, closedAt: 3 },
            { browserPageId: 'page-2', worktreeId: OTHER, closedAt: 4 }
          ],
          'env-2': [{ browserPageId: 'page-3', worktreeId: OTHER, closedAt: 5 }]
        }
      }),
      OLD,
      NEW
    )
    expect(next.clientHostedBrowserCloseIntentsByEnvironment).toEqual({
      'env-1': [
        { browserPageId: 'page-1', worktreeId: NEW, closedAt: 3 },
        { browserPageId: 'page-2', worktreeId: OTHER, closedAt: 4 }
      ],
      'env-2': [{ browserPageId: 'page-3', worktreeId: OTHER, closedAt: 5 }]
    })
  })

  it('emits neither map when no row names the renamed worktree', () => {
    const next = buildWorktreeRenameState(
      appState({
        closedTerminalTabTombstonesByTabId: { 'tab-2': { closedAt: 6, worktreeId: OTHER } },
        clientHostedBrowserCloseIntentsByEnvironment: {
          'env-1': [{ browserPageId: 'page-2', worktreeId: OTHER, closedAt: 4 }]
        }
      }),
      OLD,
      NEW
    )
    expect(Object.hasOwn(next, 'closedTerminalTabTombstonesByTabId')).toBe(false)
    expect(Object.hasOwn(next, 'clientHostedBrowserCloseIntentsByEnvironment')).toBe(false)
  })
})
