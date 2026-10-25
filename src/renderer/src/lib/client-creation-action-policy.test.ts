import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES } from '../../../shared/browser-client-hosting-eligibility'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  FLOATING_BROWSER_UNAVAILABLE_MESSAGE,
  LOCAL_BROWSER_UNAVAILABLE_MESSAGE,
  MANAGED_BROWSER_UNAVAILABLE_MESSAGE,
  MOBILE_EMULATOR_UNAVAILABLE_MESSAGE,
  assertClientCreationActionAvailable,
  assertManagedBrowserMaterializationAllowed,
  assertRuntimeManagedBrowserCreationAvailable,
  getClientCreationActionPolicy,
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
    settings: RuntimeBrowserHostingState['settings'] = {}
  ): RuntimeBrowserHostingState {
    return {
      settings,
      runtimeEnvironments: [environment],
      runtimeStatusByEnvironmentId: new Map([
        [
          environment.id,
          { status: runtimeStatus([...BROWSER_CLIENT_HOSTING_RUNTIME_CAPABILITIES]) }
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

  it('stays off when desktop-hosted remote pages are turned off, and in the web client', () => {
    const disabled = hostingState(
      { id: 'orcad-server' },
      { browserClientHostedRemoteEnabled: false }
    )
    expect(runtimeHostsPagesOnThisDesktop(disabled, 'orcad-server')).toBe(false)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    expect(
      runtimeHostsPagesOnThisDesktop(hostingState({ id: 'orcad-server' }), 'orcad-server')
    ).toBe(false)
  })
})
