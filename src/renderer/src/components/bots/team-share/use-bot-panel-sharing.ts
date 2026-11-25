import { useState } from 'react'
import { useTeamSharingOffered } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'

export type BotPanelSharing = 'people' | 'copy' | null

/** Which sharing flow the agent's panel has open. Share… closes for good once the cloud stops
 *  taking shares, so it never reopens on its own when the cloud takes them again. */
export function useBotPanelSharing(): {
  sharing: BotPanelSharing
  setSharing: (next: BotPanelSharing) => void
  sharingOffered: boolean
} {
  const [sharing, setSharing] = useState<BotPanelSharing>(null)
  const sharingOffered = useTeamSharingOffered()
  if (!sharingOffered && sharing === 'people') {
    setSharing(null)
  }
  // Set during render, so React renders again before anything shows the closed dialog.
  return { sharing, setSharing, sharingOffered }
}
