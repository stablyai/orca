export const MARKDOWN_TOC_PANEL_MIN_WIDTH = 200
export const MARKDOWN_TOC_PANEL_DEFAULT_WIDTH = 240
export const MARKDOWN_TOC_PANEL_MIN_EDITOR_WIDTH = 320
export const MARKDOWN_TOC_PANEL_MAX_WIDTH = 600

export function computeMaxMarkdownTocPanelWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return MARKDOWN_TOC_PANEL_MAX_WIDTH
  }

  return Math.min(
    MARKDOWN_TOC_PANEL_MAX_WIDTH,
    Math.max(MARKDOWN_TOC_PANEL_MIN_WIDTH, containerWidth - MARKDOWN_TOC_PANEL_MIN_EDITOR_WIDTH)
  )
}

export function clampMarkdownTocPanelWidth(
  width: unknown,
  containerWidth?: number,
  fallback = MARKDOWN_TOC_PANEL_DEFAULT_WIDTH
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }

  const maxWidth =
    containerWidth !== undefined
      ? computeMaxMarkdownTocPanelWidth(containerWidth)
      : MARKDOWN_TOC_PANEL_MAX_WIDTH

  return Math.min(maxWidth, Math.max(MARKDOWN_TOC_PANEL_MIN_WIDTH, width))
}
