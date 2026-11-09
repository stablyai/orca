import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'

export function makeTerminalTab(
  overrides: Partial<TerminalTab> & { id: string; worktreeId: string }
) {
  return {
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}
