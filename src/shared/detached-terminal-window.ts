import type {
  GlobalSettings,
  Repo,
  Tab,
  TabGroup,
  TabGroupLayoutNode,
  TerminalLayoutSnapshot,
  TerminalTab,
  Worktree
} from './types'
import type { KeybindingFileSnapshot } from './keybindings'

export type DetachedTerminalBufferSnapshot = {
  data: string
  cols: number
  rows: number
  cwd?: string | null
  seq?: number
  source?: 'headless' | 'renderer'
  lastTitle?: string
}

export type DetachedTerminalOpenSnapshot = {
  worktree: Worktree
  terminalTab: TerminalTab
  unifiedTab: Tab
  group: TabGroup
  groupLayout: TabGroupLayoutNode
  terminalLayout: TerminalLayoutSnapshot
  activeGroupId: string
  activeTabId: string
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  bufferSnapshotsByLeafId: Record<string, DetachedTerminalBufferSnapshot>
  settings: GlobalSettings
  keybindings: KeybindingFileSnapshot | null
}

export type DetachedTerminalSnapshot = DetachedTerminalOpenSnapshot & {
  ptyIds: string[]
}
