import { computeProjectHeaderDropPreview } from './project-header-drop'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'

export function isPointerInsideProjectPinTier(
  session: ProjectHeaderDragSession,
  pointerY: number,
  container: HTMLElement
): boolean {
  if (!session.fixedPinTier) {
    return true
  }
  const pointer = pointerY - container.getBoundingClientRect().top + container.scrollTop
  const first = session.headerRects[0]
  const last = session.headerRects.at(-1)
  return Boolean(
    first && last && pointer >= first.top && pointer <= (last.sectionBottom ?? last.bottom)
  )
}

export function computeProjectPinTierDropPreview(
  session: ProjectHeaderDragSession,
  pointerY: number,
  container: HTMLElement
): { dropIndex: number; dropIndicatorY: number } | null {
  if (!isPointerInsideProjectPinTier(session, pointerY, container)) {
    return null
  }
  return computeProjectHeaderDropPreview({
    pointerY,
    containerTop: container.getBoundingClientRect().top,
    scrollTop: container.scrollTop,
    rects: session.headerRects,
    sidebarRepoHeaderIds: session.sidebarRepoHeaderIds,
    contentBottom: container.scrollHeight
  })
}
