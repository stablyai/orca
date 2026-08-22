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

type TerminalWindowTransferCommandIdentity = {
  transferId: string
  tabId: string
}

export type TerminalWindowTransferCommand = TerminalWindowTransferCommandIdentity &
  (
    | {
        phase: 'target-import' | 'source-restore'
        seed: TerminalWindowTransferSeed
      }
    | {
        phase: 'target-remove' | 'source-remove'
        seed?: never
      }
  )

export type TerminalWindowTransferAck = {
  transferId: string
  tabId: string
  phase: TerminalWindowTransferPhase
  ok: boolean
  error?: string
  empty?: boolean
}

export function isTerminalWindowTransferAck(value: unknown): value is TerminalWindowTransferAck {
  const ack = value as Partial<TerminalWindowTransferAck> | null
  return Boolean(
    ack &&
    typeof ack.transferId === 'string' &&
    ack.transferId.length > 0 &&
    typeof ack.tabId === 'string' &&
    ack.tabId.length > 0 &&
    ['target-import', 'target-remove', 'source-remove', 'source-restore'].includes(
      ack.phase ?? ''
    ) &&
    typeof ack.ok === 'boolean' &&
    (ack.error === undefined || typeof ack.error === 'string') &&
    (ack.empty === undefined || typeof ack.empty === 'boolean')
  )
}

export type TerminalWindowTransferResult =
  | { ok: true; targetWindowId: number }
  | { ok: false; error: string }

export type TerminalWindowContext = {
  windowId: number
  role: 'control' | 'secondary'
  transitionFenced: boolean
}
