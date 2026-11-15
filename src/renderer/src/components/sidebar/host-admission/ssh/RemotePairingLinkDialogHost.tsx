import { AddRemoteHostDialog } from './AddRemoteHostDialog'
import {
  clearRemotePairingLink,
  useRemotePairingLinkRequestStore
} from './remote-pairing-link-request'

export function RemotePairingLinkDialogHost(): React.JSX.Element | null {
  const link = useRemotePairingLinkRequestStore((s) => s.link)
  if (!link) {
    return null
  }
  return (
    <AddRemoteHostDialog
      mode="server"
      initialPairingCode={link}
      onOpenChange={(mode) => {
        if (mode === null) {
          clearRemotePairingLink()
        }
      }}
    />
  )
}
