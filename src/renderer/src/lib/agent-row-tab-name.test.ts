import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../shared/types'
import { getAgentRowTabName } from './agent-row-tab-name'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

describe('getAgentRowTabName', () => {
  it('prefers a user-set custom title', () => {
    expect(getAgentRowTabName(makeTab({ customTitle: 'My Work', title: '✳ building' }))).toBe(
      'My Work'
    )
  })

  it('ignores a blank custom title and falls back to the live title', () => {
    expect(getAgentRowTabName(makeTab({ customTitle: '   ', title: 'Terminal 3' }))).toBe(
      'Terminal 3'
    )
  })

  it("strips the agent's leading status glyph from the live OSC title", () => {
    expect(getAgentRowTabName(makeTab({ title: '✳ implement feature' }))).toBe('implement feature')
  })

  it('returns a plain title unchanged', () => {
    expect(getAgentRowTabName(makeTab({ title: 'Terminal 1' }))).toBe('Terminal 1')
  })

  it('falls back to the default title when the live title is empty', () => {
    expect(getAgentRowTabName(makeTab({ title: '', defaultTitle: 'Terminal 2' }))).toBe(
      'Terminal 2'
    )
  })
})
