import { describe, expect, it } from 'vitest'
import {
  MARKDOWN_TOC_PANEL_DEFAULT_WIDTH,
  MARKDOWN_TOC_PANEL_MAX_WIDTH,
  MARKDOWN_TOC_PANEL_MIN_WIDTH,
  clampMarkdownTocPanelWidth,
  computeMaxMarkdownTocPanelWidth
} from './markdown-toc-panel-width'

describe('markdown toc panel width', () => {
  it('clamps widths into the supported range', () => {
    expect(clampMarkdownTocPanelWidth(undefined)).toBe(MARKDOWN_TOC_PANEL_DEFAULT_WIDTH)
    expect(clampMarkdownTocPanelWidth(100)).toBe(MARKDOWN_TOC_PANEL_MIN_WIDTH)
    expect(clampMarkdownTocPanelWidth(900)).toBe(MARKDOWN_TOC_PANEL_MAX_WIDTH)
  })

  it('respects the remaining editor width when a container size is known', () => {
    expect(computeMaxMarkdownTocPanelWidth(700)).toBe(380)
    expect(clampMarkdownTocPanelWidth(500, 700)).toBe(380)
    expect(clampMarkdownTocPanelWidth(350, 700)).toBe(350)
  })

  it('treats the second argument as container width, not a precomputed max', () => {
    const maxFor700 = computeMaxMarkdownTocPanelWidth(700)
    expect(clampMarkdownTocPanelWidth(350, maxFor700)).toBe(200)
    expect(clampMarkdownTocPanelWidth(350, 700)).toBe(350)
  })
})
