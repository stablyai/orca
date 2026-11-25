import { expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveAgentRowPaneLiveTitle } from './agent-row-pane-live-title'

const LEFT = '22222222-2222-4222-8222-222222222222'
const RIGHT = '33333333-3333-4333-8333-333333333333'
const SPLIT: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: LEFT },
    second: { type: 'leaf', leafId: RIGHT }
  },
  activeLeafId: LEFT,
  expandedLeafId: null
}

it('reads a title row name from its own sparse runtime slot, unnormalized', () => {
  const paneTitles = { 2: 'π - fix the build', 3: 'Cursor Agent' }

  expect(resolveAgentRowPaneLiveTitle(SPLIT, paneTitles, LEFT, 2)).toBe('π - fix the build')
  expect(resolveAgentRowPaneLiveTitle(SPLIT, paneTitles, RIGHT, 3)).toBe('Cursor Agent')
  expect(resolveAgentRowPaneLiveTitle(SPLIT, paneTitles, LEFT, 1)).toBeNull()
})
