import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { useAcpPermissionPrompt } from './use-acp-permission-prompt'

/**
 * Renders the tool-approval card for an ACP pane.
 *
 * Kept as its own component so the hook's subscription only exists while an ACP
 * conversation is on screen, and so NativeChatView stays under the max-lines
 * ratchet. Renders nothing when the pane is not ACP-backed or nothing is
 * pending — the terminal agents keep using NativeChatInteractiveCard, which
 * recovers approvals by scraping the agent status line.
 */
export function NativeChatAcpApprovalSlot({
  subscriptionId
}: {
  subscriptionId: string | null
}): React.JSX.Element | null {
  const permission = useAcpPermissionPrompt(subscriptionId, window.api?.nativeChat ?? null)
  if (permission.approval == null) {
    return null
  }
  return <NativeChatApprovalCard approval={permission.approval} onChoose={permission.choose} />
}
