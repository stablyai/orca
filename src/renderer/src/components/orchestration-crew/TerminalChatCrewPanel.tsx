import { useNativeChatTabOwnerWorktreeId } from '../native-chat/use-native-chat-tab-owner'
import { NativeChatCrewPanel } from './NativeChatCrewPanel'
import { useTerminalCrewIdentity } from './use-terminal-crew-identity'

/** A terminal-hosted chat's panel: resolves the pane's party only once the panel mounts. */
export function TerminalChatCrewPanel({
  terminalTabId,
  paneKey,
  targetPtyId,
  ...rest
}: {
  terminalTabId: string
  paneKey: string
  targetPtyId: string | null
} & Omit<React.ComponentProps<typeof NativeChatCrewPanel>, 'target' | 'party' | 'sessionId'>) {
  const ownerWorktreeId = useNativeChatTabOwnerWorktreeId(terminalTabId)
  const crew = useTerminalCrewIdentity(paneKey, targetPtyId, ownerWorktreeId)
  return <NativeChatCrewPanel {...crew} {...rest} />
}
