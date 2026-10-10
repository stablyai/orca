import React from 'react'
import { StatusBarSurface } from './StatusBarSurface'

export {
  buildCodexStatusSwitchGroups,
  getCodexStatusActiveId,
  normalizeCodexStatusRuntimeTarget,
  resolveCodexStatusAccountState
} from './status-bar-codex-accounts'
export {
  buildClaudeStatusSwitchGroups,
  getClaudeStatusActiveId,
  normalizeClaudeStatusRuntimeTarget,
  resolveClaudeStatusAccountState
} from './status-bar-claude-accounts'
export {
  getStatusBarPreferredWslDistro,
  type ClaudeStatusSwitchGroup,
  type ClaudeStatusSwitchTarget,
  type CodexStatusRuntimeTarget,
  type CodexStatusSwitchGroup,
  type CodexStatusSwitchTarget
} from './status-bar-runtime-targets'
export { ClaudeSwitcherMenu } from './ClaudeSwitcherMenu'
export { CodexSwitcherMenu } from './CodexSwitcherMenu'
export { InlineUsageBars } from './InlineProviderUsage'
export { ProviderDetailsMenu } from './ProviderDetailsMenu'
export { ProviderSegment } from './StatusBarProviderSegment'

export const StatusBar = React.memo(StatusBarSurface)
