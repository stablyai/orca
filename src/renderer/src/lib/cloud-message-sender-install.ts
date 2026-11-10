// Wires the cloud sender line to the signed-in identity in the store (kept out of
// cloud-message-sender.ts, which the store's delivery path imports).
import { useAppStore } from '@/store'
import { installCloudMessageSender } from './cloud-message-sender'

export function installCloudMessageSenderFromStore(): () => void {
  return installCloudMessageSender(() => useAppStore.getState().orcaProfileAuthStatus?.cloud)
}
