/** Rename must update worktree IDs inside tab-keyed close tombstones and environment-keyed browser intents or host snapshots resurrect closed surfaces. Main coverage: worktree-identity-migration-field-coverage.test.ts. */
import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { createTestStore } from '../../worktrees-slice-test-harness'
import { buildWorktreeRenameState } from './worktree-identity-rename-state'

const OLD = 'repo1::/ws/old'
const NEW = 'repo1::/ws/new'
const OTHER = 'repo1::/ws/other'

/** Real worktree slice with explicit terminal/browser maps; omitted overrides exercise nullish fallback instead of masking regressions. */
function appState(overrides: Partial<AppState>): AppState {
  const store = createTestStore()
  store.setState(overrides)
  return store.getState()
}

describe('buildWorktreeRenameState value-owned worktree rows', () => {
  it('re-points a closed-terminal-tab tombstone onto the new worktree id', () => {
    const next = buildWorktreeRenameState(
      appState({
        closedTerminalTabTombstonesByTabId: {
          'tab-1': { closedAt: 5, worktreeId: OLD, reason: 'user' },
          'tab-2': { closedAt: 6, worktreeId: OTHER }
        }
      }),
      OLD,
      NEW
    )
    expect(next.closedTerminalTabTombstonesByTabId).toEqual({
      'tab-1': { closedAt: 5, worktreeId: NEW, reason: 'user' },
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

  it('re-points a paired-host tab close intent onto the new worktree id', () => {
    const next = buildWorktreeRenameState(
      appState({
        pairedTerminalTabCloseIntentsByEnvironment: {
          'env-1': [
            { hostTabIds: ['host-1'], worktreeId: OLD, closedAt: 3, pairingRevision: 1 },
            { hostTabIds: ['host-2'], worktreeId: OTHER, closedAt: 4 }
          ]
        }
      }),
      OLD,
      NEW
    )
    expect(next.pairedTerminalTabCloseIntentsByEnvironment).toEqual({
      'env-1': [
        { hostTabIds: ['host-1'], worktreeId: NEW, closedAt: 3, pairingRevision: 1 },
        { hostTabIds: ['host-2'], worktreeId: OTHER, closedAt: 4 }
      ]
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
    expect(Object.hasOwn(next, 'pairedTerminalTabCloseIntentsByEnvironment')).toBe(false)
  })
})
