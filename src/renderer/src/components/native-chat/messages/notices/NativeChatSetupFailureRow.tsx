import {
  isNativeChatFailureRowResolved,
  useNativeChatHostSetupView
} from '../../host-access/native-chat-host-setup'

/** A setup failure a later successful turn resolved reads as history: muted, with no action. */
export function NativeChatSetupFailureRow({
  rowId,
  row
}: {
  rowId: string | undefined
  row: (resolved: boolean) => React.JSX.Element
}): React.JSX.Element {
  return row(isNativeChatFailureRowResolved(useNativeChatHostSetupView(), rowId))
}
