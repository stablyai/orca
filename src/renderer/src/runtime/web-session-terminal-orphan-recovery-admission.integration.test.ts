import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply,
  WEB_SESSION_ORPHAN_RECOVERY_MAX_SNAPSHOT_BYTES
} from './web-session-terminal-orphan-recovery'

describe('web session terminal orphan recovery admission integration', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it('rejects an oversized snapshot before RPC recovery work', async () => {
    const call = vi.fn()
    const snapshot = {
      worktree: 'repo::/worktree',
      publicationEpoch: 'x'.repeat(WEB_SESSION_ORPHAN_RECOVERY_MAX_SNAPSHOT_BYTES + 1),
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply({} as never, snapshot, 'runtime', call)
    ).resolves.toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})
