import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import { markHydratedBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import {
  seedBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from '@/lib/browser/navigation/browser-link-open.test-fixture'

import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { OrcadDeploymentLink } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { resolveNativeChatHttpLinkRouting } from './native-chat-link-target-actions'
import { handleNativeChatWebLink } from './native-chat-web-link-actions'

vi.mock('@/components/browser-pane/host-guest/input/browser-focus', () => ({
  requestBrowserFocus: vi.fn()
}))

const initialState = useAppStore.getInitialState()
const openUrl = vi.fn(async () => {})
const SSH_DEPLOYMENT: OrcadDeploymentLink = {
  sshTargetId: 'box',
  sshTargetGeneration: 1,
  localPort: 46_768,
  remotePort: 6_768
}

function resetStore(): void {
  useAppStore.setState(
    {
      ...initialState,
      remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles({
        ...initialState.remoteBrowserPageHandlesByPageId
      })
    },
    true
  )
}

beforeEach(() => {
  openUrl.mockClear()
  Object.assign(createStoreCascadesMockApi(), { shell: { openUrl } })
  resetStore()
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState({
    settings: getDefaultSettings('/home/test'),
    runtimeStatusByEnvironmentId: new Map()
  })
})

afterEach(() => {
  resetStore()
})

function seedOwner(
  hostId: ExecutionHostId,
  runtimeEnvironmentId: string | null,
  orcadDeployment: OrcadDeploymentLink | null = SSH_DEPLOYMENT
): void {
  const connectionId = hostId.startsWith('ssh:') ? hostId.slice('ssh:'.length) : null
  useAppStore.setState((state) => ({
    activeWorkspaceExecutionHostId: hostId,
    repos: state.repos.map((repo) => ({ ...repo, executionHostId: hostId, connectionId })),
    worktreesByRepo: {
      repo1: state.worktreesByRepo.repo1!.map((worktree) => ({
        ...worktree,
        hostId,
        runtimeOwnerEnvironmentId: runtimeEnvironmentId ?? undefined
      }))
    },
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        ...tab,
        executionHostId: hostId
      }))
    }
  }))
  if (!runtimeEnvironmentId) {
    return
  }
  useAppStore.setState({
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [
      {
        id: runtimeEnvironmentId,
        name: 'Box',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [
          { id: 'ws', kind: 'websocket', label: 'Box', endpoint: 'ws://127.0.0.1:46768/' }
        ],
        preferredEndpointId: 'ws',
        ...(orcadDeployment ? { orcadDeployment } : {})
      }
    ]
  })
}

function setSettings(settings: Partial<GlobalSettings>): void {
  useAppStore.setState((state) => ({ settings: { ...state.settings!, ...settings } }))
}

function clickLink(): void {
  handleNativeChatWebLink(
    {
      altKey: false,
      clientX: 0,
      clientY: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      preventDefault: () => {}
    },
    URL_TO_OPEN,
    {
      worktreeId: WORKSPACE,
      sourceTabId: 'source',
      ...resolveNativeChatHttpLinkRouting(useAppStore.getState(), WORKSPACE),
      actionsEnabled: false,
      plainClickBehavior: 'open',
      restoreFocus: () => {},
      request: () => {}
    }
  )
}

function pages(): unknown[] {
  return Object.values(useAppStore.getState().browserPagesByWorkspace).flat()
}

const THIS_DEVICE: Partial<GlobalSettings> = {
  browserSshWorkspaceRoutingDisabledTargetIds: ['box']
}

describe.each([
  ['direct SSH', 'ssh:box', null],
  ['managed SSH', 'runtime:env-box', 'env-box']
] as const)('%s on This device', (_label, hostId, runtimeEnvironmentId) => {
  beforeEach(() => seedOwner(hostId, runtimeEnvironmentId))

  it('opens an unrouted desktop tab when links open in Orca', async () => {
    setSettings({ ...THIS_DEVICE, openLinksInApp: true })

    clickLink()

    await vi.waitFor(() =>
      expect(pages()).toMatchObject([{ url: URL_TO_OPEN, browserRuntimeEnvironmentId: null }])
    )
    expect(openUrl).not.toHaveBeenCalled()
    expect(
      useAppStore
        .getState()
        .unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.contentType === 'browser')
    ).toMatchObject({ executionHostId: hostId })
  })
})
