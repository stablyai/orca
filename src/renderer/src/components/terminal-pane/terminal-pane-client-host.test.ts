import { describe, expect, it } from 'vitest'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { isTerminalPaneOnClient } from './terminal-pane-client-host'

const state: WorktreeRuntimeOwnerState = {
  repos: [
    { id: 'local-repo', executionHostId: 'local' },
    { id: 'ssh-repo', connectionId: 'box', executionHostId: 'ssh:box' },
    { id: 'managed-repo', executionHostId: 'runtime:env-1' }
  ],
  worktreesByRepo: {}
}

describe('whether a terminal pane runs on this client', () => {
  it('is true only for a local workspace', () => {
    expect(isTerminalPaneOnClient(state, 'local-repo::/home/me/app')).toBe(true)
    expect(isTerminalPaneOnClient(state, 'ssh-repo::/srv/app')).toBe(false)
    expect(isTerminalPaneOnClient(state, 'managed-repo::/root/repo')).toBe(false)
  })

  it('is false while the workspace host is still unknown', () => {
    expect(isTerminalPaneOnClient(state, 'not-loaded::/srv/app')).toBe(false)
  })
})
