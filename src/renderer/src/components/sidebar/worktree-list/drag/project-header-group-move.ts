import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import type { RenderRow } from '../listing/render-row'
import {
  computeProjectHeaderDropPreview,
  getProjectGroupOrderForSidebarDrop,
  measureProjectHeaderDragRects
} from './project-header-drop'
import type { ProjectHeaderDragSession, RepoDragState } from './project-header-drag-contract'
import {
  findSidebarRowAtContentY,
  getRootOrderDropForUngroupedEntry,
  getRootProjectHeaderKeysForHost,
  resolveProjectGroupDrop
} from './project-group-drop-target'
import { measureRootProjectHeaderDragRects } from './root-project-header-drop'

export type ProjectHeaderGroupMove = {
  rows: readonly RenderRow[]
  ancestorsByRowIndex: readonly (readonly string[])[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<string, readonly string[]>
  canDropInto: (repo: Repo, groupId: string) => boolean
  onCommitUngroup: (
    repo: Repo,
    rootOrder: { visibleKeys: string[]; dropIndex: number } | null
  ) => void
}

export type ProjectHeaderDrop =
  | { kind: 'reorder'; dropIndex: number }
  | { kind: 'into-group'; groupId: string; dropIndex: number | null }
  | { kind: 'to-root'; dropIndex: number | null; rootKeys?: readonly string[] }

export type ProjectHeaderDropResult = {
  drop: ProjectHeaderDrop | null
  dropIndicatorY: number | null
}

export const NO_PROJECT_HEADER_DROP: ProjectHeaderDropResult = { drop: null, dropIndicatorY: null }

export function getRepoDragStateForDrop(
  repoId: string,
  result: ProjectHeaderDropResult
): RepoDragState {
  return {
    draggingRepoId: repoId,
    dropIndex: result.drop?.kind === 'reorder' ? result.drop.dropIndex : null,
    dropIndicatorY: result.dropIndicatorY,
    dropTargetGroupId: result.drop?.kind === 'into-group' ? result.drop.groupId : null
  }
}

export function isSameRepoDragState(left: RepoDragState, right: RepoDragState): boolean {
  return (
    left.draggingRepoId === right.draggingRepoId &&
    left.dropIndex === right.dropIndex &&
    left.dropIndicatorY === right.dropIndicatorY &&
    left.dropTargetGroupId === right.dropTargetGroupId
  )
}

export function computeProjectHeaderDrop(args: {
  session: ProjectHeaderDragSession
  container: HTMLElement
  pointerY: number
  canReorder: boolean
  groupMove: ProjectHeaderGroupMove | undefined
  rootProjectHeaderKeys: readonly string[] | undefined
}): ProjectHeaderDropResult {
  const { session, container, groupMove } = args
  const containerTop = container.getBoundingClientRect().top
  const scrollTop = container.scrollTop
  const preview = (
    rects: Parameters<typeof computeProjectHeaderDropPreview>[0]['rects'],
    ids: readonly string[]
  ) =>
    computeProjectHeaderDropPreview({
      pointerY: args.pointerY,
      containerTop,
      scrollTop,
      rects,
      sidebarRepoHeaderIds: ids,
      contentBottom: container.scrollHeight
    })
  const computeReorder = (): ProjectHeaderDropResult => {
    const placed = args.canReorder
      ? preview(session.headerRects, session.sidebarRepoHeaderIds)
      : null
    return placed
      ? {
          drop: { kind: 'reorder', dropIndex: placed.dropIndex },
          dropIndicatorY: placed.dropIndicatorY
        }
      : NO_PROJECT_HEADER_DROP
  }
  if (!groupMove) {
    return computeReorder()
  }
  const localY = args.pointerY - containerTop + scrollTop
  const reorderSiblingGroupIds = new Set(
    session.rootProjectHeaderKeys?.flatMap((key) =>
      key.startsWith('group:') ? [key.slice('group:'.length)] : []
    )
  )
  const target = resolveProjectGroupDrop({
    localY,
    hit: findSidebarRowAtContentY(container, localY),
    rows: groupMove.rows,
    ancestorsByRowIndex: groupMove.ancestorsByRowIndex,
    sourceGroupId: session.sourceGroupId,
    reorderSiblingGroupIds,
    canDropInto: (groupId) => groupMove.canDropInto(session.repo, groupId)
  })
  if (target.kind === 'reorder') {
    return computeReorder()
  }
  if (target.kind === 'none') {
    return NO_PROJECT_HEADER_DROP
  }
  if (target.kind === 'into-group') {
    const bucketKey = `group:${target.groupId}`
    const ids = groupMove.sidebarRepoHeaderIdsByBucket.get(bucketKey) ?? []
    // Why: dropping on the header (or in "recent" order) appends; a slot only exists between projects.
    const placed =
      args.canReorder && !target.onHeader
        ? preview(measureProjectHeaderDragRects(container, bucketKey), ids)
        : null
    return {
      drop: { kind: 'into-group', groupId: target.groupId, dropIndex: placed?.dropIndex ?? null },
      dropIndicatorY: placed?.dropIndicatorY ?? null
    }
  }
  const rootKeys = args.canReorder
    ? getRootProjectHeaderKeysForHost(args.rootProjectHeaderKeys, session.sourceHostId)
    : undefined
  const placed = rootKeys
    ? preview(
        measureRootProjectHeaderDragRects(container, rootKeys, session.sourceHostId).map(
          (rect) => ({ ...rect, repoId: rect.key })
        ),
        rootKeys
      )
    : null
  return {
    drop: { kind: 'to-root', dropIndex: placed?.dropIndex ?? null, rootKeys },
    dropIndicatorY: placed?.dropIndicatorY ?? null
  }
}

export function commitProjectHeaderGroupMove(args: {
  session: ProjectHeaderDragSession
  drop: Exclude<ProjectHeaderDrop, { kind: 'reorder' }>
  groupMove: ProjectHeaderGroupMove
  orderedRepoIds: readonly string[]
  repoById: ReadonlyMap<string, Repo>
  liveRepos: readonly Repo[]
  onCommitProjectGroupOrder: (project: Repo, projectGroupId: string | null, order?: number) => void
}): void {
  const { session, drop } = args
  const draggedRepo = args.liveRepos.find((repo) => isSameRepoRow(repo, session.repo))
  // Why: a group change mid-drag (another window or client) already moved the project.
  if (
    !draggedRepo ||
    (draggedRepo.projectGroupId ?? null) !== (session.repo.projectGroupId ?? null)
  ) {
    return
  }
  if (drop.kind === 'to-root') {
    args.groupMove.onCommitUngroup(
      draggedRepo,
      drop.rootKeys && drop.dropIndex !== null
        ? getRootOrderDropForUngroupedEntry({
            rootKeys: drop.rootKeys,
            draggedKey: `repo:${draggedRepo.id}`,
            sidebarDropIndex: drop.dropIndex
          })
        : null
    )
    return
  }
  const siblings = (args.groupMove.sidebarRepoHeaderIdsByBucket.get(`group:${drop.groupId}`) ?? [])
    .map((repoId) => args.repoById.get(repoId))
    .filter((repo): repo is Repo => repo !== undefined)
  const order =
    drop.dropIndex === null || siblings.length === 0
      ? undefined
      : getProjectGroupOrderForSidebarDrop({
          siblings,
          dropIndex: drop.dropIndex,
          repoOrderRankById: getLogicalRepoOrderRankById(args.orderedRepoIds)
        })
  args.onCommitProjectGroupOrder(draggedRepo, drop.groupId, order)
}
