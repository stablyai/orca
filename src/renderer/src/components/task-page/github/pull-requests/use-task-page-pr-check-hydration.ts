import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { useAppStore } from '@/store/index'
import {
  capturePRCheckContract,
  type PRCheckContract
} from '@/lib/source-control/checks/pr-check-observation-contract'
import { getGitHubSourceRuntimeTarget } from '@/lib/work-items/github/github-source-runtime-context'
import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/work-items/github/github-work-item-source-lookup'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import {
  acceptPRCheckObservation,
  projectPRCheckOwner,
  completePRCheckOwnerScope
} from '../../../../../../shared/github/checks/complete-pr-check-owner'
import { getWorkItemRepo } from '@/lib/work-items/work-item-repo-row'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import type { TaskPageJiraCreationMetadataModel } from '../../jira/use-task-page-jira-creation-metadata'
import { deriveTaskPagePRCheckSummary } from '../../task-page-pr-check-summary'
import { PR_CHECKS_EAGER_PREFETCH_LIMIT } from '../../task-page-source-context'
import { getTaskPageRepoSourceContext } from '../../../../lib/work-items/task-repo-source-context'
import { sameOptionalGitHubOwnerRepo } from './task-page-github-review-model'
import { recomputeOn } from '@/lib/recompute-on'
export function useTaskPagePRCheckHydration(
  model: TaskPageJiraCreationMetadataModel,
  filteredWorkItems: GitHubWorkItem[],
  showPRManagementColumns: boolean
) {
  const { repos, fetchPRChecks, taskSource, githubMode, patchTaskPageWorkItemRows } = model
  const sourceContracts = useMemo(
    () =>
      model.selectedRepos.map((repo) => {
        const source = getTaskPageRepoSourceContext(repo, 'github')
        return { source, target: getGitHubSourceRuntimeTarget(source) }
      }),
    [model.selectedRepos]
  )
  const localSelected = sourceContracts.some(({ target }) => target.kind === 'local')
  const localCapabilities = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    useCallback(
      () => (localSelected ? readLocalRuntimeCapabilityObservation() : null),
      [localSelected]
    )
  )
  const runtimeStatuses = useAppStore((state) =>
    sourceContracts
      .map(({ source, target }) => {
        const contract = capturePRCheckContract(() => state, target, source)
        return `${contract.scope}:${contract.complete}`
      })
      .join('|')
  )
  // A new list query owns its own bounded demand reads.
  const checkReads = useMemo(
    () =>
      recomputeOn(
        [
          model.selectedReposKey,
          model.taskRefreshNonce,
          model.workItemsInvalidationNonce,
          model.appliedTaskSearch
        ],
        () => new Map<string, PRCheckContract>()
      ),
    [
      model.selectedReposKey,
      model.taskRefreshNonce,
      model.workItemsInvalidationNonce,
      model.appliedTaskSearch
    ]
  )
  const activeCheckReads = useRef<typeof checkReads | null>(null)
  useLayoutEffect(() => {
    activeCheckReads.current = checkReads
    return () => {
      if (activeCheckReads.current === checkReads) {
        activeCheckReads.current = null
      }
    }
  }, [checkReads])
  // Capability observations wake the existing demand trigger without adding per-row subscriptions.
  const ensurePRChecksLoaded = useMemo(
    () =>
      recomputeOn([localCapabilities, runtimeStatuses], () => (item: GitHubWorkItem): void => {
        if (item.type !== 'pr') {
          return
        }
        const repo = getWorkItemRepo(repos, item)
        if (!repo) {
          return
        }
        const sourceContext = getTaskPageRepoSourceContext(repo, 'github')
        const runtimeContract = capturePRCheckContract(
          useAppStore.getState,
          getGitHubSourceRuntimeTarget(sourceContext),
          sourceContext
        )
        const generation = model.paginationGenerationRef.current
        const contract = {
          ...runtimeContract,
          current: () =>
            runtimeContract.current() &&
            activeCheckReads.current === checkReads &&
            model.paginationGenerationRef.current === generation
        }
        if (
          item.checksSummary &&
          (!contract.complete || completePRCheckOwnerScope(item) === contract.scope)
        ) {
          return
        }
        const readKey = JSON.stringify([
          item.repoId,
          item.id,
          item.headSha,
          sourceContext,
          contract.complete
        ])
        if (checkReads.get(readKey)?.current()) {
          return
        }
        checkReads.set(readKey, contract)
        // The query's loaded/demanded rows bound attempts; eviction must not re-arm failed eager reads.
        const requestedHeadSha = item.headSha
        const requestedPRRepo = item.prRepo ?? null
        const owner = resolvePullRequestRepo(item)
        const read =
          contract.complete && owner
            ? lookupGitHubWorkItemByOwnerRepoForSource({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext,
                ...owner,
                number: item.number,
                type: 'pr',
                accepts: contract.current,
                checkContract: runtimeContract
              })
            : fetchPRChecks(
                repo.path,
                item.number,
                item.branchName,
                item.headSha,
                item.prRepo ?? null,
                {
                  repoId: repo.id,
                  sourceContext
                }
              )
        void read
          .then((result) => {
            if (!contract.current()) {
              return
            }
            const observed = Array.isArray(result) ? null : result
            if (
              contract.complete &&
              (!observed ||
                observed.headSha !== requestedHeadSha ||
                !sameOptionalGitHubOwnerRepo(observed.prRepo ?? null, requestedPRRepo))
            ) {
              return
            }
            const checksSummary = Array.isArray(result)
              ? deriveTaskPagePRCheckSummary(result)
              : observed?.checksSummary
            if (!checksSummary && !contract.complete) {
              return
            }
            const accepted =
              observed &&
              acceptPRCheckObservation(observed, item, { ...contract, current: contract.current() })
            patchTaskPageWorkItemRows(
              {
                id: item.id,
                repoId: item.repoId
              },
              contract.complete && accepted
                ? projectPRCheckOwner(accepted, {
                    checksSummary: accepted.checksSummary,
                    number: item.number,
                    url: item.url,
                    prRepo: item.prRepo,
                    headSha: item.headSha
                  })
                : { checksSummary },
              (currentItem) =>
                currentItem.type === 'pr' &&
                (!contract.complete || currentItem.checksSummary === item.checksSummary) &&
                currentItem.headSha === requestedHeadSha &&
                sameOptionalGitHubOwnerRepo(currentItem.prRepo, requestedPRRepo) &&
                (currentItem.checksSummary?.cancelled === undefined ||
                  currentItem.checksSummary.state !== checksSummary?.state ||
                  contract.complete)
            )
          })
          .catch(() => {})
      }),
    [
      localCapabilities,
      runtimeStatuses,
      checkReads,
      fetchPRChecks,
      model.paginationGenerationRef,
      patchTaskPageWorkItemRows,
      repos
    ]
  )
  useEffect(() => {
    if (taskSource !== 'github' || githubMode !== 'items' || !showPRManagementColumns) {
      return
    }
    for (const item of filteredWorkItems.slice(0, PR_CHECKS_EAGER_PREFETCH_LIMIT)) {
      ensurePRChecksLoaded(item)
    }
  }, [ensurePRChecksLoaded, filteredWorkItems, githubMode, showPRManagementColumns, taskSource])
  return ensurePRChecksLoaded
}
