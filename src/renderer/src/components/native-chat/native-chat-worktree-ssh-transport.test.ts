import { describe, expect, it } from 'vitest'
import type { AppState } from '../../store/types'
import { resolveNativeChatWorktreeSshTransport } from './native-chat-worktree-ssh-transport'

describe('resolveNativeChatWorktreeSshTransport', () => {
  it('reuses its owner index across resolutions of an unchanged catalog', () => {
    const worktreeId = 'repo-19::/remote/worktree-99'
    let idReads = 0
    const detectedWorktreesByRepo = Object.fromEntries(
      Array.from({ length: 20 }, (_, repoIndex) => [
        `repo-${repoIndex}`,
        {
          worktrees: Array.from({ length: 100 }, (_, worktreeIndex) => {
            const id = `repo-${repoIndex}::/remote/worktree-${worktreeIndex}`
            return {
              get id() {
                idReads += 1
                return id
              },
              repoId: `repo-${repoIndex}`,
              path: `/remote/worktree-${worktreeIndex}`,
              hostId: 'ssh:target-1'
            }
          })
        }
      ])
    )
    const state = {
      detectedWorktreesByRepo,
      repos: [
        {
          id: 'repo-19',
          path: '/remote/worktree-99',
          connectionId: 'target-1',
          executionHostId: 'ssh:target-1'
        }
      ],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      worktreesByRepo: {}
    } as unknown as AppState

    expect(resolveNativeChatWorktreeSshTransport(state, worktreeId, 'ssh:target-1')).toEqual({
      kind: 'resolved',
      environmentId: null
    })
    const readsAfterFirstResolution = idReads
    expect(readsAfterFirstResolution).toBeGreaterThan(0)
    expect(resolveNativeChatWorktreeSshTransport(state, worktreeId, 'ssh:target-1')).toEqual({
      kind: 'resolved',
      environmentId: null
    })
    expect(idReads).toBe(readsAfterFirstResolution)
  })
})
