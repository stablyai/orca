import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { shouldRepairActiveTerminalTab } from './active-terminal-repair'

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('shouldRepairActiveTerminalTab', () => {
  it('does not repair while editor or browser content is active', () => {
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'editor',
        activeTabId: 'missing',
        tabs: [tab('cli-terminal')]
      })
    ).toBe(false)
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'browser',
        activeTabId: null,
        tabs: [tab('cli-terminal')]
      })
    ).toBe(false)
  })

  it('repairs stale terminal active ids only while terminal content is active', () => {
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: 'missing',
        tabs: [tab('terminal-1')]
      })
    ).toBe(true)
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: 'terminal-1',
        tabs: [tab('terminal-1')]
      })
    ).toBe(false)
  })
})
