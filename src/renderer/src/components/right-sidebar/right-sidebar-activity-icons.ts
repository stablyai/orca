import { Files, GitBranch, ListChecks, Plug, Workflow } from 'lucide-react'
// Codicons (VS Code's icon set, CC BY 4.0) via react-icons.
import {
  VscChecklist,
  VscFiles,
  VscGitPullRequest,
  VscHistory,
  VscPlug,
  VscSourceControl,
  VscTypeHierarchy
} from 'react-icons/vsc'
import type { IconTheme } from '../../../../shared/global-settings-types'
import { AgentSessionHistoryIcon } from './agent-session-history-icon'
import type { ActivityBarItem } from './activity-bar-buttons'

type ActivityIcon = ActivityBarItem['icon']

export type RightSidebarActivityIcons = {
  explorer: ActivityIcon
  vault: ActivityIcon
  workspaces: ActivityIcon
  prChecks: ActivityIcon
  sourceControl: ActivityIcon
  checks: ActivityIcon
  ports: ActivityIcon
}

const DEFAULT_ACTIVITY_ICONS: RightSidebarActivityIcons = {
  explorer: Files,
  vault: AgentSessionHistoryIcon,
  workspaces: Workflow,
  prChecks: ListChecks,
  sourceControl: GitBranch,
  checks: ListChecks,
  ports: Plug
}

const VSCODE_ACTIVITY_ICONS: RightSidebarActivityIcons = {
  explorer: VscFiles,
  vault: VscHistory,
  workspaces: VscTypeHierarchy,
  prChecks: VscGitPullRequest,
  sourceControl: VscSourceControl,
  checks: VscChecklist,
  ports: VscPlug
}

export function getRightSidebarActivityIcons(
  iconTheme: IconTheme | undefined
): RightSidebarActivityIcons {
  return iconTheme === 'vscode' ? VSCODE_ACTIVITY_ICONS : DEFAULT_ACTIVITY_ICONS
}
