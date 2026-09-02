import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import * as clientCreationActionPolicy from './client-creation-action-policy'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh,
  openWorkspaceBrowserTab
} from './workspace-browser-tab-open'

const mocks = vi.hoisted(() => ({
  createRemote: vi.fn(),
  getState: vi.fn(),
  pairedWeb: false,
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.getState() }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
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
  it('opens client-owned searches with a safe title and host-specific profile', async () => {
    const createBrowserTab = vi.fn()
    const sshHost = toSshExecutionHostId('ssh-target')
    mocks.state = {
      ...ownerState(sshHost),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'focused-profile',
      defaultBrowserSessionProfileIdByHostId: { [sshHost]: 'ssh-profile' }
    }

    expect(canOpenWorkspaceBrowserTabOnSsh(mocks.state as never, WORKSPACE_ID, 'ssh-target')).toBe(
      true
    )

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      targetGroupId: 'group-1',
      url: 'https://www.google.com/search?q=private%20query',
      intent: { kind: 'search', engine: 'google' },
      expectedSshConnectionId: 'ssh-target'
    })

    expect(createBrowserTab).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'https://www.google.com/search?q=private%20query',
      {
        activate: true,
        browserRuntimeEnvironmentId: null,
        focusAddressBar: false,
        sessionProfileId: 'ssh-profile',
        targetGroupId: 'group-1',
        title: 'Search Google'
      }
    )
    expect(mocks.createRemote).not.toHaveBeenCalled()
  })

  it('creates a client tab without activating it when requested', async () => {
    const createBrowserTab = vi.fn()
    const sshHost = toSshExecutionHostId('ssh-target')
    mocks.state = {
      ...ownerState(sshHost),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'focused-profile',
      defaultBrowserSessionProfileIdByHostId: { [sshHost]: 'ssh-profile' }
    }

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: 'https://github.com/acme/orca/pull/456',
      intent: { kind: 'url' },
      focusOnCreate: false,
      selectWorktree: false
    })

    expect(createBrowserTab).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'https://github.com/acme/orca/pull/456',
      expect.objectContaining({ activate: false })
    )
  })

  it('fails closed when the asserted SSH browser route is opted out or belongs to another host', async () => {
    const sshHost = toSshExecutionHostId('ssh-target')
    mocks.state = {
      ...ownerState(sshHost),
      settings: { browserSshWorkspaceRoutingDisabledTargetIds: ['ssh-target'] },
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'focused-profile',
      defaultBrowserSessionProfileIdByHostId: { [sshHost]: 'ssh-profile' }
    }

    expect(canOpenWorkspaceBrowserTabOnSsh(mocks.state as never, WORKSPACE_ID, 'ssh-target')).toBe(
      false
    )
    expect(canOpenWorkspaceBrowserTabOnSsh(mocks.state as never, WORKSPACE_ID, 'ssh-other')).toBe(
      false
    )
    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'http://0.0.0.0:8000/',
        intent: { kind: 'url' },
        expectedSshConnectionId: 'ssh-target'
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })

  it('surfaces the opening workspace and titles runtime-owned URL tabs by target', async () => {
    const createBrowserTab = vi.fn()
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    expect(canOpenWorkspaceBrowserTabOnRuntime(mocks.state as never, WORKSPACE_ID, 'hub-a')).toBe(
      true
    )

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: 'https://example.com/docs?token=secret',
      intent: { kind: 'url' }
    })

    expect(mocks.createRemote).toHaveBeenCalledWith({
      worktreeId: WORKSPACE_ID,
      environmentId: 'hub-a',
      url: 'https://example.com/docs?token=secret',
      targetGroupId: undefined,
      selectWorktree: true,
      stagedTitle: 'example.com/docs',
      stagedFocusAddressBar: false,
      failureLogMode: 'operation-only'
    })
    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('stages a runtime tab without selecting the worktree or focusing the browser', async () => {
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: 'https://gitlab.com/acme/orca/-/merge_requests/77',
      intent: { kind: 'url' },
      focusOnCreate: false,
      selectWorktree: false
    })

    expect(mocks.createRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        focusOnCreate: false,
        selectWorktree: false,
        url: 'https://gitlab.com/acme/orca/-/merge_requests/77'
      })
    )
  })

  it('waits for host registration before reconciling an asserted runtime link', async () => {
    const createBrowserTab = vi.fn()
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }
    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: 'https://example.com/pinned',
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: 'hub-a'
    })

    expect(mocks.createRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'hub-a',
        waitForRegistration: true,
        worktreeId: WORKSPACE_ID
      })
    )
    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('keeps an asserted runtime link on its owner when policy selects the local client', async () => {
    const createBrowserTab = vi.fn()
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }
    const policySpy = vi
      .spyOn(clientCreationActionPolicy, 'getClientCreationActionPolicy')
      .mockReturnValue({
        'managed-browser': { state: 'enabled', provider: 'local-client' },
        'mobile-emulator': { state: 'enabled', provider: 'local-client' }
      })

    try {
      await openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'https://example.com/pinned',
        intent: { kind: 'url' },
        expectedRuntimeEnvironmentId: 'hub-a'
      })

      expect(mocks.createRemote).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: 'hub-a',
          waitForRegistration: true,
          worktreeId: WORKSPACE_ID
        })
      )
      expect(createBrowserTab).not.toHaveBeenCalled()
    } finally {
      policySpy.mockRestore()
    }
  })

  it('forwards an explicit server placement for owner-pinned remote panes', async () => {
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: 'https://example.com/pinned',
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: 'hub-a',
      placementPreference: 'server'
    })

    expect(mocks.createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ placementPreference: 'server' })
    )
  })

  it('fails closed when the workspace route swaps away from the pane runtime before opening', async () => {
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }
    const paneRuntimeEnvironmentId = 'hub-a'

    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-b')),
      ...browserCapableRuntime('hub-b'),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'https://example.com/',
        intent: { kind: 'url' },
        expectedRuntimeEnvironmentId: paneRuntimeEnvironmentId
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.createRemote).not.toHaveBeenCalled()
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })

  it('fails closed for a blank asserted runtime owner', async () => {
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'https://example.com/',
        intent: { kind: 'url' },
        expectedRuntimeEnvironmentId: '   '
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.createRemote).not.toHaveBeenCalled()
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })

  it('routes an asserted paired-HUB SSH owner through that runtime', async () => {
    const sshHost = toSshExecutionHostId('ssh-target')
    mocks.state = {
      ...ownerState(sshHost, 'hub-a'),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: 'http://localhost:3000/',
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: 'hub-a'
    })

    expect(mocks.createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'hub-a', worktreeId: WORKSPACE_ID })
    )
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })

  it('does not fall back to a client browser for an incapable asserted runtime', async () => {
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    expect(canOpenWorkspaceBrowserTabOnRuntime(mocks.state as never, WORKSPACE_ID, 'hub-a')).toBe(
      false
    )
    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'https://example.com/',
        intent: { kind: 'url' },
        expectedRuntimeEnvironmentId: 'hub-a'
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.createRemote).not.toHaveBeenCalled()
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })

  it('does not fall back to a client browser when asserted runtime creation fails', async () => {
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }
    mocks.createRemote.mockResolvedValue(false)

    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'https://example.com/',
        intent: { kind: 'url' },
        expectedRuntimeEnvironmentId: 'hub-a'
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'hub-a' })
    )
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })

  it('does not route an asserted floating-terminal source to either runtime or local browser', async () => {
    const createBrowserTab = vi.fn()
    mocks.state = {
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeWorkspaceExecutionHostId: toRuntimeExecutionHostId('hub-a'),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    expect(
      canOpenWorkspaceBrowserTabOnRuntime(
        mocks.state as never,
        FLOATING_TERMINAL_WORKTREE_ID,
        'hub-a'
      )
    ).toBe(false)

    await expect(
      openWorkspaceBrowserTab({
        workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
        url: 'http://localhost:3000/',
        intent: { kind: 'url' },
        expectedRuntimeEnvironmentId: 'hub-a'
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.createRemote).not.toHaveBeenCalled()
    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('keeps runtime browser actions unavailable in a paired-web floating workspace', async () => {
    mocks.pairedWeb = true
    mocks.state = {
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeWorkspaceExecutionHostId: toRuntimeExecutionHostId('hub-a'),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    expect(
      canOpenWorkspaceBrowserTabOnRuntime(
        mocks.state as never,
        FLOATING_TERMINAL_WORKTREE_ID,
        'hub-a'
      )
    ).toBe(false)
    await expect(
      openWorkspaceBrowserTab({
        workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
        url: 'http://localhost:3000/',
        intent: { kind: 'url' },
        expectedRuntimeEnvironmentId: 'hub-a'
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.createRemote).not.toHaveBeenCalled()
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })

  // Two dev servers on one host must not share a tab title.
  it('keeps the port in local-dev tab titles', async () => {
    const createBrowserTab = vi.fn()
    mocks.state = {
      ...ownerState(LOCAL_EXECUTION_HOST_ID),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'focused-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    for (const url of ['http://localhost:3000/', 'http://localhost:5173/app']) {
      await openWorkspaceBrowserTab({ workspaceId: WORKSPACE_ID, url, intent: { kind: 'url' } })
    }

    expect(createBrowserTab.mock.calls.map((call) => call[2].title)).toEqual([
      'localhost:3000',
      'localhost:5173/app'
    ])
  })

  it('uses the desktop provider when the runtime cannot stream browsers', async () => {
    const createBrowserTab = vi.fn()
    const sshHost = toSshExecutionHostId('ssh-target')
    mocks.state = {
      ...ownerState(sshHost, 'hub-a'),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'focused-profile',
      defaultBrowserSessionProfileIdByHostId: { local: 'local-profile', [sshHost]: 'ssh-profile' }
    }
    mocks.createRemote.mockResolvedValue(false)

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: 'https://www.google.com/search?q=hooks',
      intent: { kind: 'search', engine: 'google' }
    })

    expect(mocks.createRemote).not.toHaveBeenCalled()
    expect(createBrowserTab).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'https://www.google.com/search?q=hooks',
      expect.objectContaining({ sessionProfileId: 'ssh-profile', title: 'Search Google' })
    )
  })

  it('does not fall back locally when the runtime create outcome is unknown', async () => {
    const createBrowserTab = vi.fn()
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      ...browserCapableRuntime('hub-a'),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
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
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'focused-profile',
      defaultBrowserSessionProfileIdByHostId: { local: 'local-profile' }
    }
    mocks.createRemote.mockResolvedValue(false)
    await expect(openWorkspaceBrowserTab(request)).rejects.toThrow('Unable to search with Kagi.')
    expect(mocks.state.createBrowserTab).not.toHaveBeenCalled()
  })
})
