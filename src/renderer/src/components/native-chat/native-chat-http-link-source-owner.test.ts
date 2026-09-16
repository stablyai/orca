import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  canNativeChatOpenOwnedBrowser,
  resolveNativeChatHttpLinkSourceOwner
} from './native-chat-http-link-source-owner'

const mocks = vi.hoisted(() => ({
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  getConnectionIdFromState: vi.fn(),
  canOpenWorkspaceBrowserTabOnRuntime: vi.fn(),
  canOpenWorkspaceBrowserTabOnSsh: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdFromState: mocks.getConnectionIdFromState
}))
vi.mock('@/lib/workspace-browser-tab-open', () => ({
  canOpenWorkspaceBrowserTabOnRuntime: mocks.canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh: mocks.canOpenWorkspaceBrowserTabOnSsh
}))

const state = {} as AppState

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolveNativeChatHttpLinkSourceOwner', () => {
  it('prefers the workspace runtime owner', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1')

    expect(resolveNativeChatHttpLinkSourceOwner(state, 'wt-1')).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-1'
    })
    expect(mocks.getConnectionIdFromState).not.toHaveBeenCalled()
  })

  it('falls back to the SSH connection that owns the workspace', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.getConnectionIdFromState.mockReturnValue('ssh-1')

    expect(resolveNativeChatHttpLinkSourceOwner(state, 'wt-1')).toEqual({
      kind: 'ssh',
      connectionId: 'ssh-1'
    })
  })

  it('reads a null connection as local', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.getConnectionIdFromState.mockReturnValue(null)

    expect(resolveNativeChatHttpLinkSourceOwner(state, 'wt-1')).toEqual({ kind: 'local' })
  })

  // An unresolved owner must not be mistaken for local: a remote link would then
  // open against the wrong host.
  it('reports an unresolved owner as unknown', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.getConnectionIdFromState.mockReturnValue(undefined)

    expect(resolveNativeChatHttpLinkSourceOwner(state, 'wt-1')).toEqual({ kind: 'unknown' })
  })
})

describe('canNativeChatOpenOwnedBrowser', () => {
  it('asks the runtime browser-route check for a runtime owner', () => {
    mocks.canOpenWorkspaceBrowserTabOnRuntime.mockReturnValue(true)

    expect(
      canNativeChatOpenOwnedBrowser(state, 'wt-1', {
        kind: 'runtime',
        runtimeEnvironmentId: 'env-1'
      })
    ).toBe(true)
    expect(mocks.canOpenWorkspaceBrowserTabOnRuntime).toHaveBeenCalledWith(state, 'wt-1', 'env-1')
  })

  it('asks the SSH browser-route check for an SSH owner', () => {
    mocks.canOpenWorkspaceBrowserTabOnSsh.mockReturnValue(false)

    expect(
      canNativeChatOpenOwnedBrowser(state, 'wt-1', { kind: 'ssh', connectionId: 'ssh-1' })
    ).toBe(false)
    expect(mocks.canOpenWorkspaceBrowserTabOnSsh).toHaveBeenCalledWith(state, 'wt-1', 'ssh-1')
  })

  it('never claims an owned browser for local or unknown owners', () => {
    expect(canNativeChatOpenOwnedBrowser(state, 'wt-1', { kind: 'local' })).toBe(false)
    expect(canNativeChatOpenOwnedBrowser(state, 'wt-1', { kind: 'unknown' })).toBe(false)
  })
})
