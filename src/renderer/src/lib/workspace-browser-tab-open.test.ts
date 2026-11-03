import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import '../../../shared/constants'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import '../../../shared/browser-client-hosting-eligibility'
import './client-creation-action-policy'
import { openWorkspaceBrowserTab } from './workspace-browser-tab-open'

function createBrowserTabMock() {
  return vi.fn((_worktreeId: string, _url: string, _options: Record<string, unknown>) => ({
    activePageId: 'page-1'
  }))
}

const mocks = vi.hoisted(() => ({
  createRemote: vi.fn(),
  getState: vi.fn(),
  pairedWeb: false,
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.getState() }
}))

vi.mock('@/runtime/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: (...args: unknown[]) => mocks.createRemote(...args)
}))

vi.mock('./desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => mocks.pairedWeb
}))

const WORKSPACE_ID = 'repo-1::/repo/worktree'

function ownerState(hostId?: string, runtimeOwnerEnvironmentId?: string): Record<string, unknown> {
  return {
    worktreesByRepo: {
      'repo-1': [
        {
          id: WORKSPACE_ID,
          repoId: 'repo-1',
          ...(hostId ? { hostId } : {}),
          ...(runtimeOwnerEnvironmentId ? { runtimeOwnerEnvironmentId } : {})
        }
      ]
    }
  }
}

function browserCapableRuntime(environmentId: string): Record<string, unknown> {
  return {
    runtimeStatusByEnvironmentId: new Map([
      [
        environmentId,
        { status: { capabilities: [BROWSER_SCREENCAST_RUNTIME_CAPABILITY] }, checkedAt: 1 }
      ]
    ])
  }
}

beforeEach(() => {
  mocks.createRemote.mockReset().mockResolvedValue(true)
  mocks.getState.mockReset().mockImplementation(() => mocks.state)
  mocks.pairedWeb = false
  mocks.state = {}
})

describe('openWorkspaceBrowserTab', () => {
  it.each([false, true])(
    'does not fall back to a client browser when asserted runtime creation fails (client provider opt-in %s)',
    async (allowClientBrowserFallback) => {
      mocks.state = {
        ...ownerState(toRuntimeExecutionHostId('hub-a')),
        ...browserCapableRuntime('hub-a'),
        createBrowserTab: createBrowserTabMock()
      }
      mocks.createRemote.mockResolvedValue(false)

      await expect(
        openWorkspaceBrowserTab({
          workspaceId: WORKSPACE_ID,
          url: 'https://example.com/',
          intent: { kind: 'url' },
          expectedRuntimeEnvironmentId: 'hub-a',
          allowClientBrowserFallback
        })
      ).rejects.toThrow('Unable to open URL.')
      expect(mocks.createRemote).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: 'hub-a' })
      )
      expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
    }
  )

  it('does not fall back locally when the runtime create outcome is unknown', async () => {
    const createBrowserTab = createBrowserTabMock()
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab
    }
    mocks.createRemote.mockRejectedValue(new Error('create outcome unknown'))

    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'https://example.com/',
        intent: { kind: 'url' }
      })
    ).rejects.toThrow('Unable to open URL.')

    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('fails closed for invalid targets and unresolved owners, then falls back locally', async () => {
    const secretUrl = 'https://example.com/?q=secret-value'
    const request = {
      workspaceId: WORKSPACE_ID,
      url: secretUrl,
      intent: { kind: 'search' as const, engine: 'kagi' as const }
    }
    mocks.state = {}
    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'file:///secret',
        intent: { kind: 'url' }
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.getState).not.toHaveBeenCalled()

    // The friendly copy stays query-free; the diagnosable reason rides on cause.
    await expect(openWorkspaceBrowserTab(request)).rejects.toMatchObject({
      message: 'Unable to search with Kagi.',
      cause: expect.objectContaining({ message: 'no active worktree route' })
    })
    expect(mocks.createRemote).not.toHaveBeenCalled()

    for (const state of [
      ownerState('not-a-host', 'hub-a'),
      ownerState(toRuntimeExecutionHostId('hub-b'), 'hub-a')
    ]) {
      mocks.state = state
      await expect(openWorkspaceBrowserTab(request)).rejects.toThrow('Unable to search with Kagi.')
    }
    expect(mocks.createRemote).not.toHaveBeenCalled()

    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab: createBrowserTabMock()
    }
    mocks.createRemote.mockResolvedValue(false)
    await expect(openWorkspaceBrowserTab(request)).rejects.toThrow('Unable to search with Kagi.')
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })
})
