import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { CodexRestartNotice } from '../terminals/terminal-contracts'

export type DirectSshPaneRetryAttemptId = string & {
  readonly __directSshPaneRetryAttemptId: unique symbol
}

export type DirectSshPaneRetryAttempt = {
  attemptId: DirectSshPaneRetryAttemptId
  authority: DirectSshAuthority
  tabGeneration: number
  startedAt: number
}

export type DirectSshLivePtyBinding = {
  attemptId: DirectSshPaneRetryAttemptId
  authority: DirectSshAuthority
  tabGeneration: number
  ptyId: string
}

export type DirectSshPaneRetryHistory = {
  authority: DirectSshAuthority
  attemptedAt: number[]
}

export type DirectSshPaneRetryResult =
  | {
      status: 'success'
      tabId: string
      attemptId: DirectSshPaneRetryAttemptId
      authority: DirectSshAuthority
      tabGeneration: number
      ptyId: string
    }
  | {
      status: 'failed' | 'timed-out' | 'superseded'
      tabId: string
      attemptId: DirectSshPaneRetryAttemptId
      authority: DirectSshAuthority
      tabGeneration: number
    }

export type DirectSshTerminalBindingState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
  lastKnownRelayPtyIdByTabId: Record<string, string>
  pendingCodexPaneRestartIds: Record<string, true>
  codexRestartNoticeByPtyId: Record<string, CodexRestartNotice>
  directSshPaneRetryByTabId: Record<string, DirectSshPaneRetryAttempt>
  directSshLivePtyBindingByTabId: Record<string, DirectSshLivePtyBinding>
  directSshPaneRetryHistoryByTabId: Record<string, DirectSshPaneRetryHistory>
}

export type DirectSshTerminalBindingClearResult = {
  clearedCount: number
  patch: Partial<DirectSshTerminalBindingState> | null
}

export type DirectSshTerminalRetryResult = {
  retriedCount: number
  patch: Partial<DirectSshTerminalBindingState> | null
}
