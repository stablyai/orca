import '../../../../../shared/layout-owner-switch'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalSummary } from '../../../../../shared/runtime-terminal-contracts'
import { indexLiveTerminalSurfaceOwners } from './worktree-live-terminal-surface-owners'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function summary(overrides: Partial<RuntimeTerminalSummary>): RuntimeTerminalSummary {
  return {
    handle: 'term-1',
    ptyId: `${WORKTREE_ID}@@live-agent`,
    worktreeId: WORKTREE_ID,
    worktreePath: '/worktree',
    branch: 'main',
    tabId: 'tab-live',
    leafId: LEAF_ID,
    title: 'Codex',
    connected: true,
    writable: true,
    lastOutputAt: 1,
    preview: '',
    ...overrides
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('live terminal surface owners', () => {
  it.each([false, true])(
    'rejects conflicting owned and orphan rows (orphan first: %s)',
    (orphanFirst) => {
      const orphan = summary({ orphaned: true })
      const owned = summary({})
      const owners = indexLiveTerminalSurfaceOwners(
        orphanFirst ? [orphan, owned, orphan] : [owned, orphan, owned],
        WORKTREE_ID
      )

      expect(owners.get(owned.ptyId!)).toBeNull()
    }
  )
})
