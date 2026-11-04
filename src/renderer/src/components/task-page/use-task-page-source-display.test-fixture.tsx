import { cleanup } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { useTaskPageGitHubSearchPagination } from './github/use-task-page-github-search-pagination'
import { useTaskPageGitHubLandingRefresh } from './github/use-task-page-github-landing-refresh'
import { taskPageGitHubResumeCache } from './github/task-page-github-resume-cache'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import type { WorkItemsCacheSources } from '@/store/github/cache-model'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { getGitHubTaskKind } from '../../../../shared/task-github-search'
import { parseTaskQuery } from '../../../../shared/task-query'
import { useTaskPageStoreBindings } from './use-task-page-store-bindings'
import { useTaskPageRepoSelection } from './use-task-page-repo-selection'
import { useTaskPageRuntimeHosts } from './use-task-page-runtime-hosts'
import { useTaskPageSourceAvailability } from './use-task-page-source-availability'
import { useTaskPageProviderState } from './use-task-page-provider-state'
import { useTaskPageGitHubListState } from './github/use-task-page-github-list-state'
import { useTaskPageGitHubDetail } from './github/use-task-page-github-detail'
import { useTaskPageGitHubCacheReconciliation } from './github/use-task-page-github-cache-reconciliation'
import { useTaskPageSourceDisplay } from './use-task-page-source-display'
import { TaskPageGitHubFilters } from './github/Filters'
import { TaskPageGitHubList } from './github/List'
import { useTaskPageGitHubListProjection } from './github/use-task-page-github-list-projection'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

export const Q1 = 'is:issue is:open'
export const Q2 = 'is:issue label:bug'
export const upstream = { owner: 'upstream-owner', repo: 'project' }
export const fork = { owner: 'fork-owner', repo: 'project', host: 'ghe.example.com' }
export const sources = (issues: GitHubOwnerRepo | null, prs = issues): WorkItemsCacheSources => ({
  issues,
  prs,
  originCandidate: fork,
  upstreamCandidate: upstream
})
// Saved project identity is the upstream; the list's resolved source can differ.
export const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Project',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local',
  upstream
}
export const sshTwin: Repo = {
  ...repo,
  path: '/ssh/repo',
  connectionId: 'box',
  executionHostId: 'ssh:box'
}

const initialStore = useAppStore.getState()
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
// listWorkItems answers by repo path and query; a missing answer fails the fetch.
export const listAnswers = new Map<string, WorkItemsCacheSources>()
export const setIssueSourcePreference: Mock<AppState['setIssueSourcePreference']> =
  vi.fn<AppState['setIssueSourcePreference']>()

function useMountedSourceDisplay(runRequests = false) {
  const store = useTaskPageStoreBindings()
  const selection = useTaskPageRepoSelection(store)
  const hosts = useTaskPageRuntimeHosts(selection)
  const availability = useTaskPageSourceAvailability(hosts)
  const provider = useTaskPageProviderState(availability)
  const list = useTaskPageGitHubListState(provider)
  const detail = useTaskPageGitHubDetail(list)
  const reconciled = useTaskPageGitHubCacheReconciliation(detail)
  // Stage 21 derives the kind the same way before handing off to the source display.
  const kindModel = Object.assign(reconciled, {
    activeGithubTaskKind: getGitHubTaskKind(
      reconciled.activeTaskPreset,
      reconciled.appliedTaskSearch
    )
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pagination reads the stage-8 list state, source kind and store bindings present here; intervening provider stages add no GitHub pagination inputs.
  const paginationInput = kindModel as unknown as typeof kindModel &
    Parameters<typeof useTaskPageGitHubSearchPagination>[0]
  const withKind = useTaskPageGitHubSearchPagination(paginationInput)
  // Stage 26 as mounted in production; without requests its run stays inert, as before the resume step.
  useTaskPageGitHubLandingRefresh({
    ...withKind,
    taskResumeApplied: runRequests && withKind.taskResumeApplied,
    githubWorkItemMutationQueryKey: 'mounted-source-flow'
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field the source display reads comes from stages 1-8 or the kind above; stages 9-20 add none of them.
  const sourceDisplayInput = withKind as unknown as typeof withKind &
    Parameters<typeof useTaskPageSourceDisplay>[0]
  return useTaskPageSourceDisplay(sourceDisplayInput)
}
type MountedSourceDisplay = ReturnType<typeof useMountedSourceDisplay>
export let view: MountedSourceDisplay
const NO_ROW_MUTATIONS = { softHiddenItemKeys: new Set<string>() }
// A child, so the list's own subscriptions never count as Harness renders.
function MountedList({ model }: { model: MountedSourceDisplay }) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection reads stage 1-8 state and the kind; of stages 9-23 it reads only row mutations, stubbed with none hidden.
  const listInput = { ...model, githubWorkItemMutation: NO_ROW_MUTATIONS } as unknown as Parameters<
    typeof useTaskPageGitHubListProjection
  >[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: List reads stage 1-8 state, refs and the projection; Rows, the only reader of later stages, is stubbed.
  const listModel = useTaskPageGitHubListProjection(
    listInput
  ) as unknown as TaskPageComposerActionsModel
  return (
    <>
      <output data-testid="mounted-pending">{String(listModel.githubListPending)}</output>
      <TaskPageGitHubList model={listModel} />
    </>
  )
}
/** Harness renders since the last reset; a test resets it to count one update's renders. */
export const harnessRenders = { count: 0 }
export function Harness({
  runRequests = false,
  list = false
}: {
  runRequests?: boolean
  list?: boolean
}) {
  harnessRenders.count += 1
  const model = useMountedSourceDisplay(runRequests)
  // Tests read the committed model between acts.
  useLayoutEffect(() => {
    view = model
  })
  const filtersFields = {
    ...model,
    setIssueSourcePreference: runRequests
      ? useAppStore.getState().setIssueSourcePreference
      : setIssueSourcePreference,
    appliedTaskQuery: parseTaskQuery(model.appliedTaskSearch),
    loadedGitHubAuthorLogins: [],
    primaryGithubFilterSlug: null,
    githubTasksBusy: false,
    newIssueTargetRepo: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mounted stage-8 model plus these stubs cover every field Filters reads; later-stage handlers are never fired here.
  const filtersModel = filtersFields as unknown as TaskPageComposerActionsModel
  return (
    <TooltipProvider>
      <TaskPageGitHubFilters model={filtersModel} />
      <output data-testid="mounted-rows">
        {model.pages[model.currentPage]?.map((row) => row.title).join(',') ?? ''}
      </output>
      <output data-testid="mounted-count">{model.countedTotalPages ?? 'unknown'}</output>
      {list ? <MountedList model={model} /> : null}
    </TooltipProvider>
  )
}

/** Each mounted source-display test starts from a clean store, preload API and resume cache. */
export function installSourceDisplayTestLifecycle() {
  beforeEach(() => {
    taskPageGitHubResumeCache.clear()
    listAnswers.clear()
    setIssueSourcePreference.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        gh: {
          countWorkItems: vi.fn().mockResolvedValue(0),
          viewer: vi.fn().mockResolvedValue(null),
          listWorkItems: vi.fn(async ({ repoPath, query = '' }) => {
            const answer = listAnswers.get(`${repoPath}\0${query}`)
            if (!answer) {
              throw new Error('list failed')
            }
            return { items: [], sources: answer }
          })
        },
        repos: { update: vi.fn(async ({ repoId }) => ({ ...repo, id: repoId })) },
        ui: { set: vi.fn().mockResolvedValue(undefined) }
      }
    })
    useAppStore.setState({ ...initialStore, workItemsCache: {} }, true)
  })
  afterEach(async () => {
    await i18n.changeLanguage('en')
    cleanup()
    useAppStore.setState(initialStore, true)
    if (initialApiDescriptor) {
      Object.defineProperty(window, 'api', initialApiDescriptor)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  })
}
