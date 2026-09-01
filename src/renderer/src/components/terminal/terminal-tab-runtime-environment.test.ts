import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { resolveTerminalTabRuntimeEnvironment } from './terminal-tab-runtime-environment'

function makeState(ptyIds: string[]): Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'> {
  return {
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: ptyIds[0] ?? null,
          worktreeId: 'wt-1',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': ptyIds.slice(1) }
  }
}

describe('resolveTerminalTabRuntimeEnvironment', () => {
  it('returns the unique environment from terminal PTY evidence', () => {
    const state = makeState(['remote:runtime-a@@terminal-1', 'remote:runtime-a@@terminal-2'])

    expect(resolveTerminalTabRuntimeEnvironment(state, 'wt-1', 'tab-1')).toEqual({
      kind: 'runtime',
      environmentId: 'runtime-a'
    })
  })

  it('rejects conflicting remote PTY owners', () => {
    const state = makeState(['remote:runtime-a@@terminal-1', 'remote:runtime-b@@terminal-2'])

    expect(resolveTerminalTabRuntimeEnvironment(state, 'wt-1', 'tab-1')).toEqual({
      kind: 'conflict'
    })
  })

  it('returns no owner without live PTY evidence', () => {
    expect(resolveTerminalTabRuntimeEnvironment(makeState([]), 'wt-1', 'tab-1')).toEqual({
      kind: 'none'
    })
  })
})
