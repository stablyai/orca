import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { Repo } from '../../../../../../shared/repo-types'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import type { UseRepoHeaderDragArgs } from './project-header-drag-contract'
import { getProjectHeaderDragBucketKey, getProjectHeaderHostBucketKey } from './project-header-drop'
import { getRootProjectHeaderDragKeys } from './root-project-header-drop'

export type ProjectHeaderMoveToTop = {
  isFirst: (repo: Repo, rowHostId?: string) => boolean
  move: (repo: Repo, rowHostId?: string) => void
}

function getMoveToTopList(args: UseRepoHeaderDragArgs, repo: Repo, rowHostId?: string) {
  const bucketKey = getProjectHeaderDragBucketKey(repo)
  const rootKey = `repo:${repo.id}`
  // Why: mirrors the drag session, which scopes root keys to the header's host section.
  const hostId = args.rootProjectHeaderKeys?.some((key) => key.startsWith('host:'))
    ? (rowHostId ?? '')
    : undefined
  const rootProjectHeaderKeys = getRootProjectHeaderDragKeys(
    args.rootProjectHeaderKeys,
    rootKey,
    hostId
  )
  // Why: a bucket spans every host section; "top" means the top of this header's own section.
  const ids =
    rootProjectHeaderKeys ??
    args.sidebarRepoHeaderIdsByHostBucket?.get(
      getProjectHeaderHostBucketKey(rowHostId, bucketKey)
    ) ??
    args.sidebarRepoHeaderIdsByBucket.get(bucketKey) ??
    []
  return {
    session: { repo, bucketKey, rootProjectHeaderKeys, sidebarRepoHeaderIds: ids },
    ownId: rootProjectHeaderKeys ? rootKey : repo.id
  }
}

// Moves a project header to the first slot of its list through the same commit as a header drop.
export function useProjectHeaderMoveToTop(args: UseRepoHeaderDragArgs): ProjectHeaderMoveToTop {
  const argsRef = useRef(args)
  useLayoutEffect(() => {
    argsRef.current = args
  })
  const isFirst = useCallback((repo: Repo, rowHostId?: string) => {
    const { session, ownId } = getMoveToTopList(argsRef.current, repo, rowHostId)
    return session.sidebarRepoHeaderIds[0] === ownId
  }, [])
  const move = useCallback((repo: Repo, rowHostId?: string) => {
    const current = argsRef.current
    commitProjectHeaderDragDrop({
      ...current,
      session: getMoveToTopList(current, repo, rowHostId).session,
      sidebarDropIndex: 0,
      liveRepos: current.getLiveRepos()
    })
  }, [])
  return useMemo(() => ({ isFirst, move }), [isFirst, move])
}
