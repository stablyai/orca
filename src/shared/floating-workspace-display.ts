export type WorkspaceDisplayInfo = {
  id: number
  label: string
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  isPrimary: boolean
  scaleFactor: number
}

export type CalculateTargetDisplayBoundsOptions = {
  currentBounds?: { width: number; height: number }
  defaultWidth?: number
  defaultHeight?: number
}

/**
 * Calculates centered window bounds constrained within the target display's work area.
 */
export function calculateTargetDisplayBounds(
  targetDisplay: Pick<WorkspaceDisplayInfo, 'workArea'>,
  options: CalculateTargetDisplayBoundsOptions = {}
): { x: number; y: number; width: number; height: number } {
  const defaultWidth = options.defaultWidth ?? 960
  const defaultHeight = options.defaultHeight ?? 640
  const width = Math.min(options.currentBounds?.width ?? defaultWidth, targetDisplay.workArea.width)
  const height = Math.min(
    options.currentBounds?.height ?? defaultHeight,
    targetDisplay.workArea.height
  )
  const x =
    targetDisplay.workArea.x + Math.max(0, Math.round((targetDisplay.workArea.width - width) / 2))
  const y =
    targetDisplay.workArea.y + Math.max(0, Math.round((targetDisplay.workArea.height - height) / 2))
  return { x, y, width, height }
}

/**
 * Finds the next display in the list to cycle between monitors.
 */
export function findNextDisplay(
  displays: readonly WorkspaceDisplayInfo[],
  currentDisplayId?: number | null
): WorkspaceDisplayInfo | null {
  if (displays.length === 0) {
    return null
  }
  if (displays.length === 1) {
    return displays[0]
  }
  const currentIndex = displays.findIndex((d) => d.id === currentDisplayId)
  if (currentIndex === -1) {
    // If not on a known display or no currentDisplayId given, pick the first non-primary display if available
    const nonPrimary = displays.find((d) => !d.isPrimary)
    return nonPrimary ?? displays[0]
  }
  const nextIndex = (currentIndex + 1) % displays.length
  return displays[nextIndex]
}
