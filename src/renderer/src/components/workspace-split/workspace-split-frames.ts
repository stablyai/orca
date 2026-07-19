import type { WorkspacePaneNode } from '../../../../shared/types'

/** Percent-based rect (0–100) relative to the workspace body. */
export type WorkspacePaneFrame = {
  left: number
  top: number
  width: number
  height: number
}

export type WorkspaceSplitDividerDescriptor = {
  /** Path from the root to the split node this divider resizes. */
  path: ('first' | 'second')[]
  /** Split direction: 'horizontal' = side-by-side columns (vertical divider line). */
  direction: 'horizontal' | 'vertical'
  /** Boundary line position along the split axis, in percent. */
  linePosition: number
  /** Start/length of the divider along the cross axis, in percent. */
  crossStart: number
  crossLength: number
  /** The split node's own region — needed to map a pointer position to a ratio. */
  region: WorkspacePaneFrame
}

export type WorkspaceSplitGeometry = {
  frameByWorktreeId: Map<string, WorkspacePaneFrame>
  dividers: WorkspaceSplitDividerDescriptor[]
}

/** Walk the pane tree once, producing each leaf's frame and one divider per
 *  split node. Ratio defaults to 0.5, mirroring TabGroupSplitLayout. */
export function computeWorkspaceSplitGeometry(layout: WorkspacePaneNode): WorkspaceSplitGeometry {
  const frameByWorktreeId = new Map<string, WorkspacePaneFrame>()
  const dividers: WorkspaceSplitDividerDescriptor[] = []

  const walk = (
    node: WorkspacePaneNode,
    region: WorkspacePaneFrame,
    path: ('first' | 'second')[]
  ): void => {
    if (node.type === 'pane') {
      frameByWorktreeId.set(node.worktreeId, region)
      return
    }
    const ratio = node.ratio ?? 0.5
    if (node.direction === 'horizontal') {
      const firstWidth = region.width * ratio
      const boundary = region.left + firstWidth
      dividers.push({
        path,
        direction: 'horizontal',
        linePosition: boundary,
        crossStart: region.top,
        crossLength: region.height,
        region
      })
      walk(node.first, { ...region, width: firstWidth }, [...path, 'first'])
      walk(node.second, { ...region, left: boundary, width: region.width - firstWidth }, [
        ...path,
        'second'
      ])
    } else {
      const firstHeight = region.height * ratio
      const boundary = region.top + firstHeight
      dividers.push({
        path,
        direction: 'vertical',
        linePosition: boundary,
        crossStart: region.left,
        crossLength: region.width,
        region
      })
      walk(node.first, { ...region, height: firstHeight }, [...path, 'first'])
      walk(node.second, { ...region, top: boundary, height: region.height - firstHeight }, [
        ...path,
        'second'
      ])
    }
  }

  walk(layout, { left: 0, top: 0, width: 100, height: 100 }, [])
  return { frameByWorktreeId, dividers }
}

/** Map a pointer position inside the container to the divider's new ratio. */
export function resolveDividerRatioFromPointer(
  divider: WorkspaceSplitDividerDescriptor,
  containerRect: { left: number; top: number; width: number; height: number },
  pointer: { clientX: number; clientY: number }
): number {
  if (divider.direction === 'horizontal') {
    const regionLeftPx = containerRect.left + (divider.region.left / 100) * containerRect.width
    const regionWidthPx = (divider.region.width / 100) * containerRect.width
    return regionWidthPx > 0 ? (pointer.clientX - regionLeftPx) / regionWidthPx : 0.5
  }
  const regionTopPx = containerRect.top + (divider.region.top / 100) * containerRect.height
  const regionHeightPx = (divider.region.height / 100) * containerRect.height
  return regionHeightPx > 0 ? (pointer.clientY - regionTopPx) / regionHeightPx : 0.5
}
