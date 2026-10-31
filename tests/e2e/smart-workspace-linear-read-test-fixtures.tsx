import { useStore } from 'zustand'
import { createTestStore } from '@/store/slices/linear-slice-test-harness'
import { clearLinearRequestMaps } from '@/store/slices/linear/linear-slice-request-state'
// @vitest-environment happy-dom

import React from 'react'
import type * as ReactModule from 'react'
import type * as MainLinearClient from '../../src/main/linear/client'
import type * as RuntimeLinearClient from '@/runtime/runtime-linear-client'
import type * as RuntimeLinearIssueMutations from '@/runtime/runtime-linear-issue-mutations'
import { registerRuntimeClientIpcBridge } from '@/hooks/ipc-events/runtime-client-ipc-bridge'
import type { RuntimeClientEvent } from '../../src/shared/runtime-client-events'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import type { LinearIssue } from '../../src/shared/linear/issue-types'
import type { LinearConnectionStatus } from '../../src/shared/linear/workspace-types'
import type { Repo } from '../../src/shared/repo-types'
import { WorkspaceAttachmentSourceStatus } from '../../src/renderer/src/components/sidebar/WorkspaceAttachmentSourceStatus'
import { Command } from '@/components/ui/command'
import {
  referenceLinearIssue,
  referenceRepo
} from '../../src/renderer/src/components/sidebar/workspace-reference-fixtures.test-support'
import { SmartWorkspaceSourceResultList } from '../../src/renderer/src/components/new-workspace/SmartWorkspaceSourceResultList'
import { useWorkItemSourceSearch } from '../../src/renderer/src/components/new-workspace/use-work-item-source-search'

const queued = vi.hoisted(() => {
  const updates: VoidFunction[] = []
  return { enabled: false, updates }
})
vi.mock('react', async (original) => {
  const actual = await original<typeof ReactModule>()
  return {
    ...actual,
    useReducer<S, A>(reducer: (previous: S, action: A) => S, initial: S) {
      const [value, dispatch] = actual.useReducer(reducer, initial)
      const send = actual.useCallback((action: A) => {
        if (
          queued.enabled &&
          typeof initial === 'object' &&
          initial !== null &&
          'whole' in initial
        ) {
          queued.updates.push(() => dispatch(action))
        } else {
          dispatch(action)
        }
      }, [])
      return [value, send] as const
    }
  }
})
const detailTransport = vi.hoisted(() => {
  const credential: { message?: string } = {}
  return {
    issue: vi.fn(),
    rpc: vi.fn(),
    search: vi.fn(),
    clear: vi.fn(),
    workspaces: ['workspace-1'],
    accountFixture: false,
    credential,
    AuthError: class AuthenticationLinearError extends Error {}
  }
})
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: (...args: unknown[]) => detailTransport.rpc(...args)
}))
vi.mock('../../src/main/linear/client', async (original) => {
  const actual = await original<typeof MainLinearClient>()
  return {
    ...actual,
    getClients: (workspaceId: string) =>
      detailTransport.accountFixture
        ? actual.getClients(workspaceId)
        : [
            {
              workspace: { id: workspaceId, organizationName: 'Acme' },
              client: {
                issue: (id: string) => detailTransport.issue(id, workspaceId),
                client: { rawRequest: (...args: unknown[]) => detailTransport.search(...args) }
              }
            }
          ]
  }
})
vi.mock('../../src/main/linear/linear-sdk', () => {
  class LinearClient {
    client: { rawRequest: (...args: unknown[]) => Promise<unknown> }
    apiKey: string
    constructor({ apiKey }: { apiKey: string }) {
      this.apiKey = apiKey
      this.client = { rawRequest: (...args) => detailTransport.search(...args, apiKey) }
    }
    issue(id: string) {
      return detailTransport.issue(id, this.apiKey)
    }
  }
  return {
    loadLinearSdk: () => ({ AuthenticationLinearError: detailTransport.AuthError, LinearClient }),
    createLinearClient: (options: { apiKey: string }) => new LinearClient(options)
  }
})
vi.mock('../../src/main/linear/linear-workspace-registry', () => ({
  getWorkspaceState: () => ({
    workspaces: detailTransport.workspaces.map((id) => ({
      id,
      organizationId: id,
      organizationName: 'Acme'
    })),
    activeWorkspaceId: detailTransport.workspaces[0] ?? null,
    selectedWorkspaceId: detailTransport.workspaces[0] ?? null
  }),
  resolveWorkspaceId: (id?: string | null) => id ?? detailTransport.workspaces[0],
  getCredentialError: () => detailTransport.credential.message
}))
vi.mock('../../src/main/linear/linear-token-store', () => ({
  clearToken: (id: string) => {
    detailTransport.workspaces = detailTransport.workspaces.filter((workspace) => workspace !== id)
    detailTransport.clear(id)
  },
  loadToken: ({ workspaceId }: { workspaceId: string }) => {
    if (detailTransport.credential.message) {
      throw new Error(detailTransport.credential.message)
    }
    return workspaceId
  },
  getWorkspaceTokenProtection: () => null
}))
const events = vi.hoisted(() => ({ emit: (_event: RuntimeClientEvent) => {} }))
vi.mock('@/runtime/runtime-client-events', () => ({
  subscribeRuntimeClientEvents: async (
    _id: string,
    onEvent: (event: RuntimeClientEvent) => void
  ) => {
    events.emit = onEvent
    return { unsubscribe: () => {} }
  }
}))
const mocks = vi.hoisted(() => {
  // Host-wide status carries no error: the composer must show the read's own failure.
  const linearStatus: LinearConnectionStatus = {
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'workspace-1'
  }
  return {
    statusReads: vi.fn(),
    state: {
      checkLinearConnection: vi.fn(),
      getCachedLinearIssues: vi.fn(),
      linearStatus,
      // The repo's own host: its status refresh reaches the composer's host-scoped read.
      linearStatusContextKey: 'runtime:env-1#0',
      linearStatusObserved: true,
      linearStatusChecked: true,
      settings: null,
      preflightStatus: null,
      preflightStatusChecked: true,
      preflightStatusContextKey: 'test',
      refreshPreflightStatus: vi.fn(),
      searchLinearIssues: vi.fn(),
      list: vi.fn(),
      detail: vi.fn()
    }
  }
})
export const actual = await vi.importActual<typeof RuntimeLinearIssueMutations>(
  '@/runtime/runtime-linear-issue-mutations'
)
export const actualSearch = await vi.importActual<typeof RuntimeLinearClient>(
  '@/runtime/runtime-linear-client'
)
let stopBridge = () => {}
let restoreApi = () => {}
export let pickerStore: ReturnType<typeof createTestStore>
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: Parameters<typeof pickerStore>[0]) => useStore(pickerStore, selector),
    {
      getState: () => pickerStore.getState(),
      subscribe: (...args: Parameters<typeof pickerStore.subscribe>) =>
        pickerStore.subscribe(...args)
    }
  )
}))
vi.mock('@/runtime/runtime-linear-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearStatus: async (source: unknown) =>
    (await mocks.statusReads(source)) ?? mocks.state.linearStatus,
  linearListIssues: (...args: unknown[]) => mocks.state.list(...args),
  linearSearchIssues: (
    settings: unknown,
    query: string,
    limit?: number,
    workspaceId?: string | null
  ) => mocks.state.searchLinearIssues(query, settings, limit, workspaceId)
}))
vi.mock('@/runtime/runtime-linear-issue-mutations', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearGetIssue: (...args: unknown[]) => mocks.state.detail(...args)
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'test'
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../src/renderer/src/components/new-workspace/use-jira-source-connection', () => ({
  useJiraSourceConnection: () => ({ status: null, loaded: false })
}))
vi.mock('../../src/renderer/src/components/new-workspace/use-jira-url-source', () => ({
  useJiraUrlSource: () => ({ intent: false })
}))
vi.mock('../../src/renderer/src/components/use-jira-project-inventory', () => ({
  useJiraProjectInventory: () => ({ projects: [], connected: true, error: null, loading: false })
}))

export const repo: Repo = { ...referenceRepo, executionHostId: 'runtime:env-1' }
// Stable identity: search effects depend on the repos array.
const repos = [repo]
export const onSelect = vi.fn()
const ignoreRetry = () => {}

export function LinearPicker({
  value,
  attachment = false,
  defaultSource = false,
  onRetry = ignoreRetry
}: {
  value: string
  attachment?: boolean
  defaultSource?: boolean
  onRetry?: () => void
}): React.JSX.Element {
  const controller = useWorkItemSourceSearch({
    repos,
    selectedRepo: defaultSource ? null : repo,
    repoId: defaultSource ? '' : repo.id,
    value,
    branchesEnabled: false,
    repoBackedSourcesDisabled: true
  })
  return (
    <Command>
      <button type="button" onClick={() => controller.setMode('linear')}>
        Linear tab
      </button>
      <button type="button" onClick={() => controller.setMode('smart')}>
        Smart tab
      </button>
      <SmartWorkspaceSourceResultList model={controller} onSelect={onSelect} />
      {attachment ? (
        <WorkspaceAttachmentSourceStatus
          controller={controller}
          taskUrlProvider="linear"
          resolved={controller.searchResultRows.length > 0}
          error={null}
          onRetry={onRetry}
        />
      ) : null}
    </Command>
  )
}

export function prepareDefaultPicker(status: LinearConnectionStatus) {
  clearLinearRequestMaps()
  pickerStore = createTestStore()
  mocks.state.linearStatus = status
  pickerStore.setState({
    // SAFETY: these consumers only inspect the active host and listed refresh methods.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
    linearStatus: status,
    linearStatusObserved: true,
    linearStatusChecked: true,
    linearStatusContextKey: 'runtime:env-1#0',
    preflightStatusChecked: true,
    preflightStatusContextKey: 'test',
    refreshPreflightStatus: vi.fn(),
    fetchHostWorkspaceStatuses: vi.fn(async () => {}),
    fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
    fetchProjectGroups: vi.fn(async () => {}),
    fetchFolderWorkspaces: vi.fn(async () => {}),
    fetchWorktreeLineage: vi.fn(async () => {}),
    runtimeStatusByEnvironmentId: new Map(),
    runtimeEnvironments: [],
    sshStateByEnvironment: new Map()
  })
}
export function installRuntimeBridge() {
  const previousApi = window.api
  restoreApi = () => Object.assign(window, { api: previousApi })
  Object.assign(window, { api: { runtimeEnvironments: {} } })
  const unsubs: VoidFunction[] = []
  const stop = registerRuntimeClientIpcBridge(unsubs, {
    worktreeChangeRefreshQueue: { enqueue: vi.fn(), dispose: vi.fn() },
    activateNotifiedWorktree: vi.fn(async () => {})
  })
  stopBridge = () => {
    stop()
    unsubs.forEach((unsubscribe) => unsubscribe())
  }
}
export function aliasStatus(legacy = false): LinearConnectionStatus {
  return {
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'L',
    workspaces: [
      legacy
        ? {
            displayName: 'Test',
            email: null,
            id: 'L',
            organizationId: 'L',
            organizationName: 'Saved workspace',
            isLegacy: true
          }
        : {
            displayName: 'Test',
            email: null,
            id: 'L',
            organizationId: 'org',
            organizationName: 'Acme',
            organizationUrlKey: 'acme'
          },
      {
        displayName: 'Test',
        email: null,
        id: 'W',
        organizationId: 'org',
        organizationName: 'Acme',
        ...(legacy ? {} : { organizationUrlKey: 'acme' })
      },
      {
        displayName: 'Test',
        email: null,
        id: 'F',
        organizationId: 'foreign',
        organizationName: 'Foreign',
        organizationUrlKey: 'foreign'
      }
    ]
  }
}
export function aliasRow(title: string, workspaceId = 'L'): LinearIssue {
  return {
    ...referenceLinearIssue(),
    id: 'U',
    identifier: 'ENG-1',
    workspaceId,
    title,
    url: 'https://linear.app/acme/issue/ENG-1/task'
  }
}

export function resetPickerStore() {
  pickerStore = createTestStore()
}
afterEach(() => {
  mocks.statusReads.mockReset()
  detailTransport.accountFixture = false
  detailTransport.workspaces = ['workspace-1']
  delete detailTransport.credential.message
  stopBridge()
  stopBridge = () => {}
  restoreApi()
  restoreApi = () => {}
  queued.enabled = false
  queued.updates.length = 0
  cleanup()
  clearLinearRequestMaps()
})

export { queued, detailTransport, events, mocks }
