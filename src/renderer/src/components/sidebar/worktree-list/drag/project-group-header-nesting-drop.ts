import type { RenderRow } from '../listing/render-row'
import { computeProjectGroupHeaderDropPreview } from './project-group-header-drop'
import type {
  ProjectGroupHeaderDragSession,
  ProjectGroupNestingDrop
} from './project-group-header-drag-contract'
import {
  findSidebarRowAtContentY,
  getProjectGroupDragSource,
  getRootOrderDropForUngroupedEntry,
  getRootProjectHeaderKeysForHost,
  type SidebarRowHit
} from './project-group-drop-target'
import { measureRootProjectHeaderDragRects } from './root-project-header-drop'

export type ProjectGroupHeaderNesting = {
  rows: readonly RenderRow[]
  ancestorsByRowIndex: readonly (readonly string[])[]
  rootProjectHeaderKeys: readonly string[] | undefined
  getHostId: (groupId: string) => string | undefined
  canMove: (groupId: string, parentGroupId: string | null) => boolean
  onCommitParent: (groupId: string, drop: ProjectGroupNestingDrop) => void
}

export type ProjectGroupHeaderDrop = {
  dropIndex: number | null
  dropIndicatorY: number | null
  nestingDrop?: ProjectGroupNestingDrop
}

// Header edges keep the reorder slot beside a group; only its middle band means "into".
const NEST_EDGE_PX = 6

function resolveProjectGroupHeaderParentTarget(args: {
  nesting: ProjectGroupHeaderNesting
  session: ProjectGroupHeaderDragSession
  localY: number
  hit: SidebarRowHit | null
}): 'reorder' | 'none' | { parentGroupId: string | null; hostId?: string } {
  const { nesting, session, hit } = args
  if (!hit) {
    return 'none'
  }
  const chain = nesting.ancestorsByRowIndex[hit.index] ?? []
  if (chain.includes(session.groupId)) {
    return 'reorder'
  }
  const row = nesting.rows[hit.index]
  const headerGroupId = row?.type === 'header' && !row.repo ? row.projectGroup?.id : undefined
  const offset = args.localY - hit.top
  if (
    headerGroupId &&
    headerGroupId !== session.parentGroupId &&
    offset >= NEST_EDGE_PX &&
    offset < hit.height - NEST_EDGE_PX
  ) {
    return nesting.canMove(session.groupId, headerGroupId)
      ? { parentGroupId: headerGroupId }
      : 'none'
  }
  // Why: a header's edge band means "beside" it, so the context is the header's own parent.
  const context =
    headerGroupId && headerGroupId !== session.parentGroupId ? chain.slice(0, -1) : chain
  // Why: rows under the current parent keep the existing reorder, so expanded siblings stay easy to pass.
  if (session.parentGroupId === null || context.includes(session.parentGroupId)) {
    return 'reorder'
  }
  const { sourceHostId } = getProjectGroupDragSource(
    nesting.rows,
    nesting.ancestorsByRowIndex,
    hit.index
  )
  if (sourceHostId !== undefined && sourceHostId !== nesting.getHostId(session.groupId)) {
    return 'none'
  }
  const innerGroupId = context.at(-1) ?? null
  return nesting.canMove(session.groupId, innerGroupId)
    ? { parentGroupId: innerGroupId, hostId: sourceHostId }
    : 'none'
}

export function computeProjectGroupHeaderNestingDrop(args: {
  nesting: ProjectGroupHeaderNesting
  session: ProjectGroupHeaderDragSession
  container: HTMLElement
  pointerY: number
  computeReorder: () => ProjectGroupHeaderDrop | null
}): ProjectGroupHeaderDrop | null {
  const { nesting, session, container } = args
  const containerTop = container.getBoundingClientRect().top
  const localY = args.pointerY - containerTop + container.scrollTop
  const target = resolveProjectGroupHeaderParentTarget({
    nesting,
    session,
    localY,
    hit: findSidebarRowAtContentY(container, localY)
  })
  if (target === 'reorder') {
    return args.computeReorder()
  }
  if (target === 'none') {
    return null
  }
  if (target.parentGroupId !== null) {
    return {
      dropIndex: null,
      dropIndicatorY: null,
      nestingDrop: { parentGroupId: target.parentGroupId, rootOrder: null }
    }
  }
  const rootKeys = getRootProjectHeaderKeysForHost(nesting.rootProjectHeaderKeys, target.hostId)
  const placed = rootKeys
    ? computeProjectGroupHeaderDropPreview({
        pointerY: args.pointerY,
        containerTop,
        scrollTop: container.scrollTop,
        rects: measureRootProjectHeaderDragRects(container, rootKeys, target.hostId).map(
          (rect) => ({ ...rect, groupId: rect.key })
        ),
        sidebarProjectGroupHeaderIds: rootKeys,
        contentBottom: container.scrollHeight
      })
    : null
  return {
    dropIndex: null,
    dropIndicatorY: placed?.dropIndicatorY ?? null,
    nestingDrop: {
      parentGroupId: null,
      rootOrder:
        rootKeys && placed
          ? getRootOrderDropForUngroupedEntry({
              rootKeys,
              draggedKey: `group:${session.groupId}`,
              sidebarDropIndex: placed.dropIndex
            })
          : null
    }
  }
}
