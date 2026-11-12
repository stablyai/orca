import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import {
  seedBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from '@/lib/browser/navigation/browser-link-open.test-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { nativeChatLinkActions } from './native-chat-link-target-actions'

vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))

const initialState = useAppStore.getInitialState()

beforeEach(() => {
  createStoreCascadesMockApi()
  useAppStore.setState(initialState, true)
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/test'), openLinksInApp: true },
    runtimeStatusByEnvironmentId: new Map()
  })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function seedOwner(hostId: ExecutionHostId, runtimeEnvironmentId: string | null): void {
  useAppStore.setState((state) => ({
    activeWorkspaceExecutionHostId: hostId,
    repos: state.repos.map((repo) => ({
      ...repo,
      executionHostId: hostId,
      connectionId: runtimeEnvironmentId ? null : 'box'
    })),
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
}

async function openChatLink(runtimeEnvironmentId: string | null): Promise<void> {
  const actions = nativeChatLinkActions(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    worktreePath: '/repo',
    runtimeEnvironmentId,
    sourceTabId: 'source'
  })
  await actions?.primary.run()
  await vi.waitFor(() =>
    expect(Object.values(useAppStore.getState().browserPagesByWorkspace).flat()).toMatchObject([
      { url: 'https://example.com/a#one', browserRuntimeEnvironmentId: null }
    ])
  )
}

it('opens a chat link in the desktop browser when SSH traffic routing is disabled', async () => {
  seedOwner('ssh:box', null)
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, browserSshWorkspaceRoutingEnabled: false }
  }))

  await openChatLink(null)

  expect(
    useAppStore
      .getState()
      .unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.contentType === 'browser')
  ).toMatchObject({ executionHostId: 'ssh:box' })
})

it('opens a managed SSH chat link locally when this host uses device networking', async () => {
  seedOwner('runtime:env-box', 'env-box')
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, browserSshWorkspaceRoutingDisabledTargetIds: ['box'] },
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [
      {
        id: 'env-box',
        name: 'Box',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [
          { id: 'ws', kind: 'websocket', label: 'Box', endpoint: 'ws://127.0.0.1:46768/' }
        ],
        preferredEndpointId: 'ws',
        orcadDeployment: {
          sshTargetId: 'box',
          sshTargetGeneration: 1,
          localPort: 46_768,
          remotePort: 6_768
        }
      }
    ]
  }))

  await openChatLink('env-box')

  expect(
    useAppStore
      .getState()
      .unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.contentType === 'browser')
  ).toMatchObject({ executionHostId: 'runtime:env-box' })
})
