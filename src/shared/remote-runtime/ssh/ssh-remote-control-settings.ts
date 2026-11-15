/** Global settings for SSH hosts controlling this desktop. */
export type SshRemoteControlSettings = {
  /** One-shot guard: hosts saved before the remote CLI control default flip were pinned off. */
  sshRemoteCliControlExistingHostsMigrated?: boolean
  /** SSH hosts already told, once, that they are controlling a desktop browser tab. */
  desktopBrowserBridgeNoticedTargetIds?: string[]
}
