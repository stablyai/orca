import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserLinkTestStore, WORKSPACE } from './browser-link-open.test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES } from '../../../shared/browser-client-hosting-eligibility'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  FLOATING_BROWSER_UNAVAILABLE_MESSAGE,
  LOCAL_BROWSER_UNAVAILABLE_MESSAGE,
  MANAGED_BROWSER_UNAVAILABLE_MESSAGE,
  MOBILE_EMULATOR_UNAVAILABLE_MESSAGE,
  assertClientCreationActionAvailable,
  assertManagedBrowserMaterializationAllowed,
  assertRuntimeManagedBrowserCreationAvailable,
  getClientCreationActionPolicy,
  getWorkspaceClientCreationActionPolicy,
  resolveClientCreationActionPolicy,
  runtimeHostsPagesOnThisDesktop,
  type RuntimeBrowserHostingState
} from './client-creation-action-policy'

function runtimeStatus(capabilities?: string[]): RuntimeStatus {
  return {
    runtimeId: 'runtime-1',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    hostPlatform: 'darwin',
    capabilities
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('resolveClientCreationActionPolicy', () => {
  it('preserves Electron creation behavior without negotiated runtime signals', () => {
    expect(resolveClientCreationActionPolicy({ surface: 'electron', runtimeStatus: null })).toEqual(
      {
        'managed-browser': { state: 'enabled', provider: 'local-client' },
        'mobile-emulator': { state: 'enabled', provider: 'local-client' }
      }
    )
  })

  it('selects the provider that the browser action path can actually consume', () => {
    const desktopHost = runtimeStatus(['browser.screencast.v1'])
    const npmHostWithoutDisplay = { ...runtimeStatus(), hostPlatform: 'linux' as const }
    const npmHostWithDisplay = {
      ...runtimeStatus(['browser.screencast.v1', 'browser.headless.v1']),
      hostPlatform: 'linux' as const
    }

    expect(
      resolveClientCreationActionPolicy({ surface: 'electron', runtimeStatus: desktopHost })
    ).toEqual({
      'managed-browser': { state: 'enabled', provider: 'paired-runtime' },
      'mobile-emulator': { state: 'enabled', provider: 'local-client' }
    })
    expect(
      resolveClientCreationActionPolicy({
        surface: 'electron',
        runtimeStatus: npmHostWithoutDisplay
      })
    ).toEqual({
      'managed-browser': { state: 'enabled', provider: 'local-client' },
      'mobile-emulator': { state: 'enabled', provider: 'local-client' }
    })
    expect(
      resolveClientCreationActionPolicy({ surface: 'paired-web', runtimeStatus: desktopHost })
    ).toEqual({
      'managed-browser': { state: 'enabled', provider: 'paired-runtime' },
      'mobile-emulator': { state: 'hidden', reason: MOBILE_EMULATOR_UNAVAILABLE_MESSAGE }
    })
    expect(
      resolveClientCreationActionPolicy({
        surface: 'paired-web',
        runtimeStatus: npmHostWithoutDisplay
      })
    ).toEqual({
      'managed-browser': { state: 'hidden', reason: MANAGED_BROWSER_UNAVAILABLE_MESSAGE },
      'mobile-emulator': { state: 'hidden', reason: MOBILE_EMULATOR_UNAVAILABLE_MESSAGE }
    })
    expect(
      resolveClientCreationActionPolicy({
        surface: 'paired-web',
        runtimeStatus: npmHostWithDisplay
      })['managed-browser']
    ).toEqual({ state: 'enabled', provider: 'paired-runtime' })
  })

  it('enables paired-web browser creation only with negotiated streaming support', () => {
    expect(
      resolveClientCreationActionPolicy({
        surface: 'paired-web',
        runtimeStatus: runtimeStatus(['browser.screencast.v1'])
      })['managed-browser']
    ).toEqual({ state: 'enabled', provider: 'paired-runtime' })

    expect(
      resolveClientCreationActionPolicy({
        surface: 'paired-web',
        runtimeStatus: runtimeStatus()
      })['managed-browser']
    ).toEqual({ state: 'hidden', reason: MANAGED_BROWSER_UNAVAILABLE_MESSAGE })
  })

  it('hides web-client floating browsers and mobile emulators as impossible surfaces', () => {
    const policy = resolveClientCreationActionPolicy({
      surface: 'paired-web',
      runtimeStatus: runtimeStatus(['browser.screencast.v1', 'mobile.tasks.v1']),
      floatingWorkspace: true
    })

    expect(policy['managed-browser']).toEqual({
      state: 'hidden',
      reason: FLOATING_BROWSER_UNAVAILABLE_MESSAGE
    })
    expect(policy['mobile-emulator']).toEqual({
      state: 'hidden',
      reason: MOBILE_EMULATOR_UNAVAILABLE_MESSAGE
    })
  })
})

describe('client creation action guards', () => {
  it.each([false, true])('does not read server focus for a workspace policy (web: %s)', (web) => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', web)
    const store = createBrowserLinkTestStore()
    const settings = getDefaultSettings('/home/test')
    Object.defineProperty(settings, 'activeRuntimeEnvironmentId', {
      get: () => {
        throw new Error('Workspace policy read server focus')
      }
    })
    store.setState({ settings })

    const policy = getWorkspaceClientCreationActionPolicy(store.getState(), WORKSPACE)
    expect(policy['managed-browser']).toEqual(
      web
        ? { state: 'hidden', reason: MANAGED_BROWSER_UNAVAILABLE_MESSAGE }
        : { state: 'enabled', provider: 'local-client' }
    )
    expect(getClientCreationActionPolicy(store.getState(), WORKSPACE)).toEqual(policy)
  })

  it('fails closed for an older paired runtime and rejects local browser materialization', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const state = {
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
      runtimeStatusByEnvironmentId: new Map([
        ['runtime-1', { status: runtimeStatus(), checkedAt: 1 }]
      ])
    }

    expect(getClientCreationActionPolicy(state as never, null)['managed-browser'].state).toBe(
      'hidden'
    )
    expect(() =>
      assertClientCreationActionAvailable(state as never, null, 'managed-browser')
    ).toThrow(MANAGED_BROWSER_UNAVAILABLE_MESSAGE)
    expect(() => assertManagedBrowserMaterializationAllowed(state as never, null)).toThrow(
      LOCAL_BROWSER_UNAVAILABLE_MESSAGE
    )
  })

  it('permits host-confirmed remote browser materialization in paired web', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const state = {
      runtimeStatusByEnvironmentId: new Map([
        ['runtime-1', { status: runtimeStatus(['browser.screencast.v1']), checkedAt: 1 }]
      ])
    }
    expect(() =>
      assertManagedBrowserMaterializationAllowed(state as never, 'runtime-1')
    ).not.toThrow()
  })

  it('treats the floating workspace as local even with an active capable runtime', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const state = {
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
      runtimeStatusByEnvironmentId: new Map([
        ['runtime-1', { status: runtimeStatus(['browser.screencast.v1']), checkedAt: 1 }]
      ])
    }

    expect(
      getClientCreationActionPolicy(state as never, FLOATING_TERMINAL_WORKTREE_ID)[
        'managed-browser'
      ]
    ).toEqual({ state: 'hidden', reason: FLOATING_BROWSER_UNAVAILABLE_MESSAGE })
  })

  it('uses folder and SSH workspace ownership instead of the focused runtime', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const capableStatus = runtimeStatus(['browser.screencast.v1'])
    const state = {
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      folderWorkspaces: [
        {
          id: 'remote-folder',
          projectGroupId: 'remote-group',
          executionHostId: toRuntimeExecutionHostId('folder-owner')
        }
      ],
      projectGroups: [
        { id: 'remote-group', executionHostId: toRuntimeExecutionHostId('folder-owner') }
      ],
      worktreesByRepo: {
        repo: [
          {
            id: 'ssh-worktree',
            repoId: 'repo',
            hostId: toSshExecutionHostId('ssh-owner')
          }
        ]
      },
      runtimeStatusByEnvironmentId: new Map([
        ['folder-owner', { status: capableStatus, checkedAt: 1 }],
        ['focused-runtime', { status: capableStatus, checkedAt: 1 }]
      ])
    }

    expect(
      getClientCreationActionPolicy(state as never, folderWorkspaceKey('remote-folder'))[
        'managed-browser'
      ]
    ).toEqual({ state: 'enabled', provider: 'paired-runtime' })
    expect(
      getClientCreationActionPolicy(state as never, 'ssh-worktree')['managed-browser']
    ).toEqual({ state: 'hidden', reason: MANAGED_BROWSER_UNAVAILABLE_MESSAGE })
  })
})

describe('a runtime whose pages this desktop hosts', () => {
  function hostingState(
    environment: Pick<PublicKnownRuntimeEnvironment, 'id' | 'orcadDeployment'>,
    settings: RuntimeBrowserHostingState['settings'] = {},
    extraCapabilities: string[] = []
  ): RuntimeBrowserHostingState {
    return {
      settings,
      runtimeEnvironments: [environment],
      runtimeStatusByEnvironmentId: new Map([
        [
          environment.id,
          {
            status: runtimeStatus([
              ...BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES,
              ...extraCapabilities
            ])
          }
        ]
      ])
    }
  }

  it('creates runtime-placed tabs for a paired server with no browser of its own', () => {
    const state = hostingState({ id: 'orcad-server' })
    expect(runtimeHostsPagesOnThisDesktop(state, 'orcad-server')).toBe(true)
    expect(() => assertRuntimeManagedBrowserCreationAvailable(state, 'orcad-server')).not.toThrow()
    expect(
      resolveClientCreationActionPolicy({
        surface: 'electron',
        runtimeStatus: runtimeStatus(),
        runtimeHostsPagesOnThisDesktop: true
      })['managed-browser']
    ).toEqual({ state: 'enabled', provider: 'paired-runtime' })
  })

  it('keeps a managed SSH deployment on its desktop tabs and SSH browser route', () => {
    const state = hostingState({
      id: 'managed-ssh',
      orcadDeployment: {
        sshTargetId: 'target-1',
        sshTargetGeneration: 1,
        localPort: 1,
        remotePort: 2
      }
    })
    expect(runtimeHostsPagesOnThisDesktop(state, 'managed-ssh')).toBe(false)
    expect(() => assertRuntimeManagedBrowserCreationAvailable(state, 'managed-ssh')).toThrow()
  })

  it('leaves pages on a streaming server when the setting asks for server rendering', () => {
    const streaming = hostingState(
      { id: 'electron-server' },
      { browserClientHostedRemoteEnabled: false },
      [BROWSER_SCREENCAST_RUNTIME_CAPABILITY]
    )
    expect(runtimeHostsPagesOnThisDesktop(streaming, 'electron-server')).toBe(false)
  })

  it('hosts through the server it cannot stream from even when the setting asks for server rendering', () => {
    const state = hostingState({ id: 'orcad-server' }, { browserClientHostedRemoteEnabled: false })
    expect(runtimeHostsPagesOnThisDesktop(state, 'orcad-server')).toBe(true)
  })

  it('stays off in the web client', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    expect(
      runtimeHostsPagesOnThisDesktop(hostingState({ id: 'orcad-server' }), 'orcad-server')
    ).toBe(false)
  })
})
