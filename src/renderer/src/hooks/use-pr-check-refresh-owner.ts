import { useCallback, useState } from 'react'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import {
  acceptPRCheckObservation,
  completePRCheckOwnerScope,
  projectPRCheckOwner,
  samePRCheckObservation
} from '../../../shared/github/complete-pr-check-owner'

export function usePRCheckRefreshOwner(item: GitHubWorkItem, source?: TaskSourceContext | null) {
  const sourceKey = source ? getTaskSourceCacheScope(source) : 'local'
  const [refreshed, setRefreshed] = useState<{
    base: GitHubWorkItem
    owner: GitHubWorkItem
    sourceKey: string
  } | null>(null)
  const onOwnerUpdated = useCallback(
    (owner: GitHubWorkItem) => {
      const scope = completePRCheckOwnerScope(owner)
      if (!scope) {
        return
      }
      setRefreshed((previous) => ({
        base: item,
        sourceKey,
        owner: acceptPRCheckObservation(
          owner,
          previous?.sourceKey === sourceKey ? previous.owner : item,
          { scope, complete: true, current: true }
        )!
      }))
    },
    [item, sourceKey]
  )
  const sameTarget =
    refreshed && item.number === refreshed.base.number && item.url === refreshed.base.url
  const parentHeadChanged = refreshed && item.headSha !== refreshed.base.headSha
  const projected =
    refreshed &&
    projectPRCheckOwner(refreshed.owner, {
      ...item,
      headSha: refreshed.owner.headSha,
      checksSummary: refreshed.owner.checksSummary
    })
  const parentSuperseded =
    completePRCheckOwnerScope(item) !== undefined &&
    refreshed &&
    !samePRCheckObservation(item, refreshed.base) &&
    !samePRCheckObservation(item, refreshed.owner)
  const checkOwner =
    refreshed?.sourceKey === sourceKey &&
    sameTarget &&
    !parentHeadChanged &&
    projected &&
    completePRCheckOwnerScope(projected) &&
    !parentSuperseded
      ? projected
      : item
  return { checkOwner, onOwnerUpdated }
}
