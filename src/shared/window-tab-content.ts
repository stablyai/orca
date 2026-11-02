import type { AgentType } from './agent-status-types'
import type { TuiAgent } from './tui-agent'
import type { TabContentRef } from './workspace-layout/workspace-layout-tab-content'

/** What a switch puts in the window's tab: its running terminal, or the conversation's chat. */
export type WindowTabContent =
  | {
      kind: 'terminal'
      terminalId: string
      leafId: string
      ptyId: string
      title?: string
      launchAgent?: TuiAgent
    }
  | { kind: 'agent-session'; sessionId: string; agent: AgentType }

/** Main asks the window that owns the layout to change what one of its tabs holds. */
export type WindowTabContentRequest = {
  requestId: string
  worktreeId: string
  /** Main's best id for the tab; the window finds the tab holding the source when it differs. */
  tabId?: string
  expectSource: TabContentRef
  content: WindowTabContent
  /** The switch came from this window: focus moves into the new content if the user is on it. */
  focus: boolean
  /** Only answer which tab would take the content, changing nothing: main records the chat's
   *  tab before anything retires the source. */
  decide?: boolean
  /** Read just `tabId` (no search by content): what a decided tab holds now. */
  exact?: boolean
  /** Past this (ms since epoch) the window refuses: a request delivered late changes nothing. */
  expiresAt: number
}

/** Whether a tab now holds the content, and which; false changed nothing. */
export type WindowTabContentOutcome = { retargeted: boolean; tabId?: string }

export type WindowTabContentReply = WindowTabContentOutcome & { requestId: string; error?: string }
