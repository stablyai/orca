import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveSnapshotSessionLabel } from './resource-session-labels'

describe('a restored terminal row', () => {
  it('names its bound tab even when the daemon reported no pane key', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the label reads only the titles set here.
    const tab = { id: 'tab-1', customTitle: 'Build' } as TerminalTab
    const index = {
      ptyIdToTabId: new Map([['pty-1', 'tab-1']]),
      tabIdToWorktreeId: new Map([['tab-1', 'repo::/w']]),
      boundPtyIds: new Set(['pty-1']),
      tabsByIdByWorktree: new Map([['repo::/w', new Map([['tab-1', { tab, index: 0 }]])]])
    }

    expect(
      resolveSnapshotSessionLabel(
        { sessionId: 'pty-1', paneKey: null, pid: 4242, cpu: 0, memory: 0 },
        'repo::/w',
        index,
        'tab-1'
      )
    ).toBe('Build')
  })
})
