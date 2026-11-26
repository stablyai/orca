import { noopUnsubscribe } from '../web-storage'

/** The web client has no OS shell delivering orca:// links, so none is ever pending. */
export const WEB_PENDING_LINK_API = {
  onOpenSkillShare: () => noopUnsubscribe,
  consumePendingSkillShare: () => Promise.resolve(null),
  onBotLinkPending: () => noopUnsubscribe,
  consumePendingBotLink: () => Promise.resolve(null),
  onOpenPluginInstallLink: () => noopUnsubscribe,
  consumePendingPluginInstallLink: () => Promise.resolve(null)
}
