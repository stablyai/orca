import { expect, vi } from 'vitest'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { requestGitHubCheckDetails } from '@/components/github-item-dialog/inspect-pull-request/checks-tab-request-details'
import type { ChecksTabActionContext } from '@/components/github-item-dialog/inspect-pull-request/checks-tab-actions'
import { requestPullRequestCheckDetails } from '@/components/pull-request-page/checks/details-request'
import {
  createGitHubChecksTabState,
  resolveGitHubChecksTabState
} from '@/components/github-checks-tab-state'
import {
  createTestStore,
  githubSourceContext,
  mockApi,
  runtimeEnvironmentSubscribe,
  runtimeEnvironmentTransportCall
} from '../slices/github-slice-test-harness'

export const check: PRCheckDetail = {
  name: 'fork-build',
  status: 'completed',
  conclusion: 'failure',
  checkRunId: 123,
  workflowRunId: 456,
  url: 'https://github.example.com/fork/widgets/actions/runs/456'
}
export const prRepo = { owner: 'Fork', repo: 'Widgets', host: 'github.example.com' }
export const details: PRCheckRunDetails = {
  name: check.name,
  status: 'completed',
  conclusion: 'failure',
  url: check.url,
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  title: 'Synthetic result',
  summary: null,
  text: null,
  annotations: [],
  jobs: []
}
export const surfaces = ['store', 'dialog', 'page'] as const
export const transports = ['ipc', 'rpc'] as const
export type Surface = (typeof surfaces)[number]
export type Transport = (typeof transports)[number]
type StoreSettlement =
  | { status: 'fulfilled'; details: PRCheckRunDetails | null }
  | { status: 'rejected'; error: unknown }

export function createLoader(surface: Surface, transport: Transport) {
  const sourceContext = githubSourceContext(
    transport === 'rpc' ? 'runtime:source-env' : 'ssh:source-host',
    'source-repo-id'
  )
  const store = createTestStore()
  store.setState({
    settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'focused-env' }),
    repos: [
      {
        id: 'caller-repo',
        path: '/folder',
        displayName: 'Folder',
        badgeColor: '',
        addedAt: 1,
        kind: 'folder'
      }
    ]
  })
  let state = createGitHubChecksTabState([check], 'source-context')
  let storeSettlement: StoreSettlement | undefined
  const ctx: ChecksTabActionContext = {
    canUseChecksRepoContext: true,
    runtimeHost:
      transport === 'rpc'
        ? { kind: 'runtime', id: 'runtime:source-env', environmentId: 'source-env' }
        : null,
    sourceContext,
    repoId: 'caller-repo',
    repoPath: '/folder',
    itemNumber: 42,
    itemRepoId: 'item-repo',
    headSha: 'head',
    prRepo,
    mountedRef: { current: true },
    committedChecksContextOwnerRef: { current: state.contextOwner },
    nextChecksRefreshRequestIdRef: { current: 0 },
    activeChecksRefreshRequestIdRef: { current: null },
    nextCheckDetailsRequestIdRef: { current: 0 },
    setChecksState: (updater) => {
      state = typeof updater === 'function' ? updater(state) : updater
    },
    setRefreshingOwner: vi.fn(),
    setRerunningOwner: vi.fn(),
    onChecksUpdated: vi.fn()
  }
  const start = (nextCheck = check): void => {
    if (surface === 'store') {
      void store
        .getState()
        .fetchPRCheckDetails(
          '/folder',
          { ...nextCheck, checkName: nextCheck.name, prRepo },
          { repoId: 'caller-repo', sourceContext: ctx.sourceContext }
        )
        .then(
          (result) => {
            storeSettlement = { status: 'fulfilled', details: result }
          },
          (error: unknown) => {
            storeSettlement = { status: 'rejected', error }
          }
        )
    } else if (surface === 'dialog') {
      expect(requestGitHubCheckDetails(ctx, nextCheck, 'check')).toBeUndefined()
    } else {
      expect(
        requestPullRequestCheckDetails({
          ...ctx,
          check: nextCheck,
          key: 'check',
          item: {
            id: 'pr',
            type: 'pr',
            number: 42,
            title: 'Fork PR',
            state: 'open',
            url: 'https://github.example.com/fork/widgets/pull/42',
            labels: [],
            updatedAt: '2026-10-13T00:00:00Z',
            author: null,
            repoId: 'item-repo'
          }
        })
      ).toBeUndefined()
    }
  }
  return {
    start,
    ctx,
    store,
    state: () => state,
    storeSettlement: () => storeSettlement,
    replaceContext: () => {
      state = resolveGitHubChecksTabState(state, [check], 'replacement-context')
      ctx.sourceContext = githubSourceContext('runtime:replacement-env', 'replacement-repo')
    }
  }
}

export function expectRequestCounts(transport: Transport, count = 1) {
  expect(mockApi.gh.prCheckDetails).toHaveBeenCalledTimes(transport === 'ipc' ? count : 0)
  expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(transport === 'rpc' ? count : 0)
  expect(runtimeEnvironmentTransportCall.mock.calls.map(([args]) => args.method)).toEqual(
    transport === 'rpc' ? ['status.get'] : []
  )
}

export function successResponse(value: PRCheckRunDetails | null = details) {
  return { id: 'details', ok: true, result: value, _meta: { runtimeId: 'source-runtime' } }
}
