import type { ExecutionHostId } from './execution-host'
import type { WorkspaceKey } from './folder-workspace-types'
import type { Repo } from './repo-types'
import type { TabGroup } from './tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'

export type TerminalWindowTransferSeed = {
  tabId: string
  hostId: ExecutionHostId
  canonicalWorkspaceKey: WorkspaceKey
  repo: Repo
  worktreeId: string
  group: TabGroup
  tab: TerminalTab
  layout: TerminalLayoutSnapshot
  ptyIds: string[]
}

export type TerminalWindowTransferPhase =
  | 'target-import'
  | 'target-remove'
  | 'source-remove'
  | 'source-restore'

export type TerminalWindowTransferCommand = {
  tabId: string
  phase: TerminalWindowTransferPhase
  seed?: TerminalWindowTransferSeed
}

export type TerminalWindowTransferAck = {
  tabId: string
  phase: TerminalWindowTransferPhase
  ok: boolean
  error?: string
  empty?: boolean
}

export type TerminalWindowTransferResult =
  | { ok: true; targetWindowId: number }
  | { ok: false; error: string }

export type TerminalWindowContext = {
  windowId: number
  role: 'control' | 'secondary'
  transitionFenced: boolean
}
