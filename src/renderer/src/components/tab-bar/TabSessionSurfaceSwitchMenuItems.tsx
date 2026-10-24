import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { CliChatResumeMenuItems } from './CliChatResumeMenuItems'
import { NativeChatCliForkMenuItems } from './NativeChatCliForkMenuItems'
import type { NativeChatTabSession } from './tab-session-history-switch'

export function TabSessionSurfaceSwitchMenuItems(props: {
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
  nativeChat?: NativeChatTabSession
  leadingSeparator: boolean
  onComplete?: () => void
}): React.JSX.Element | null {
  return props.nativeChat ? (
    <NativeChatCliForkMenuItems {...props} nativeChat={props.nativeChat} />
  ) : (
    <CliChatResumeMenuItems {...props} />
  )
}
