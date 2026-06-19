import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import { sanitizeTerminalLayoutPaneTitles } from './terminal-pane-title-sanitization'

const TAB: TerminalTab = {
  id: 'tab-1',
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  title: 'Terminal 1',
  defaultTitle: 'Terminal 1',
  customTitle: 'Nightly audit',
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function singlePaneLayout(title: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: 'leaf-1' },
    activeLeafId: 'leaf-1',
    expandedLeafId: null,
    titlesByLeafId: { 'leaf-1': title }
  }
}

describe('sanitizeTerminalLayoutPaneTitles', () => {
  it('drops a single-pane title that duplicates the tab custom label', () => {
    expect(sanitizeTerminalLayoutPaneTitles(singlePaneLayout('Nightly audit'), TAB)).toEqual({
      root: { type: 'leaf', leafId: 'leaf-1' },
      activeLeafId: 'leaf-1',
      expandedLeafId: null
    })
  })

  it('drops generated terminal labels from single-pane layouts', () => {
    expect(
      sanitizeTerminalLayoutPaneTitles(singlePaneLayout('Terminal 2'), TAB)
    ).not.toHaveProperty('titlesByLeafId')
  })

  it('drops quick command labels from single-pane layouts', () => {
    expect(
      sanitizeTerminalLayoutPaneTitles(singlePaneLayout('Run tests'), {
        ...TAB,
        quickCommandLabel: 'Run tests'
      })
    ).not.toHaveProperty('titlesByLeafId')
  })

  it('keeps an intentional single-pane title that is not a tab label', () => {
    expect(sanitizeTerminalLayoutPaneTitles(singlePaneLayout('build logs'), TAB)).toHaveProperty(
      'titlesByLeafId',
      { 'leaf-1': 'build logs' }
    )
  })

  it('keeps split-pane titles even when one matches the tab label', () => {
    const layout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-1' },
        second: { type: 'leaf', leafId: 'leaf-2' }
      },
      activeLeafId: 'leaf-1',
      expandedLeafId: null,
      titlesByLeafId: {
        'leaf-1': 'Nightly audit',
        'leaf-2': 'build logs'
      }
    }

    expect(sanitizeTerminalLayoutPaneTitles(layout, TAB)).toBe(layout)
  })
})
