export {
  MARKDOWN_TOC_PANEL_DEFAULT_WIDTH,
  MARKDOWN_TOC_PANEL_MAX_WIDTH,
  MARKDOWN_TOC_PANEL_MIN_WIDTH,
  clampMarkdownTocPanelWidth,
  computeMaxMarkdownTocPanelWidth
} from '../../../../shared/markdown-toc-panel-width'

// Why: match the worktree/right sidebar 4px resize target; a 1px seam is too hard to acquire.
export const MARKDOWN_TOC_RESIZE_HANDLE_CLASS_NAME =
  'absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-ring/20 active:bg-ring/30'
