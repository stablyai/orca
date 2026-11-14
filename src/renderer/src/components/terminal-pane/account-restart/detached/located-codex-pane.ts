import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

export type LocatedCodexPane = {
  worktreeId: string
  tab: TerminalTab
  leafId: string | null
  generation: number
}
