import { createContext, useContext } from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'

export type AgentRowMenuOpenRequest = {
  row: DashboardAgentRow
  label: string
  element: HTMLElement
  event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>
  /** Keyboard opens anchor at the row; pointer opens at the cursor. */
  anchor: 'pointer' | 'row'
  onActivate: (tabId: string, paneKey: string) => void
}

export type AgentRowMenuController = {
  open: (request: AgentRowMenuOpenRequest) => void
}

/** Stable per card so opening or closing a menu never re-renders its agent rows. */
export const AgentRowMenuContext = createContext<AgentRowMenuController | null>(null)

export function useAgentRowMenuController(): AgentRowMenuController | null {
  return useContext(AgentRowMenuContext)
}
