import { acceptPRCheckObservation } from '../../../shared/github/complete-pr-check-owner'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'
import { capturePRCheckContract } from './pr-check-observation-contract'
import { getGitHubSourceRuntimeTarget } from './github-source-runtime-context'
import { lookupGitHubWorkItemByOwnerRepoForSource } from './work-items/github/github-work-item-source-lookup'
import { useAppStore } from '@/store'

export async function readPRCheckRefreshOwner(args: {
  repoPath: string | null
  repoId: string
  sourceContext?: TaskSourceContext | null
  ownerRepo: GitHubOwnerRepo | null
  item: GitHubWorkItem
  accepts: () => boolean
}) {
  const contract = capturePRCheckContract(
    useAppStore.getState,
    getGitHubSourceRuntimeTarget(args.sourceContext),
    args.sourceContext
  )
  const current = () => args.accepts() && contract.current()
  if (!contract.complete || !args.ownerRepo) {
    return { current, rpcOptions: contract.rpcOptions }
  }
  try {
    const owner = await lookupGitHubWorkItemByOwnerRepoForSource({
      repoPath: args.repoPath ?? '',
      repoId: args.repoId,
      sourceContext: args.sourceContext,
      ...args.ownerRepo,
      number: args.item.number,
      type: 'pr',
      accepts: current,
      checkContract: contract
    })
    return { current, owner: owner ?? undefined, rpcOptions: contract.rpcOptions }
  } catch (error) {
    return {
      current,
      error,
      owner:
        acceptPRCheckObservation({ ...args.item, checksSummary: undefined }, null, {
          ...contract,
          current: current(),
          trusted: false
        }) ?? undefined,
      rpcOptions: contract.rpcOptions
    }
  }
}
