import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'

export const SOURCE_LEAF_LAYOUT = {
  root: { type: 'leaf', leafId: 'leaf-source' },
  activeLeafId: 'leaf-source',
  expandedLeafId: null,
  ptyIdsByLeafId: { 'leaf-source': 'pty-bg' }
} satisfies TerminalLayoutSnapshot

export const BACKGROUND_SPLIT_LAYOUT = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: 'leaf-source' },
    second: { type: 'leaf', leafId: 'leaf-split-background' },
    ratio: 0.5
  },
  activeLeafId: 'leaf-source',
  expandedLeafId: null,
  ptyIdsByLeafId: {
    'leaf-source': 'pty-bg',
    'leaf-split-background': 'pty-split-background'
  }
} satisfies TerminalLayoutSnapshot

export const FOCUSED_SPLIT_LAYOUT = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: 'leaf-source' },
    second: { type: 'leaf', leafId: 'leaf-split' },
    ratio: 0.5
  },
  activeLeafId: 'leaf-split',
  expandedLeafId: null,
  ptyIdsByLeafId: {
    'leaf-source': 'pty-bg',
    'leaf-split': 'pty-split'
  }
} satisfies TerminalLayoutSnapshot
