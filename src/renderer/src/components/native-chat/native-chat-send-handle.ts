export type NativeChatSendHandle = {
  cancel: () => void
  settleAfterMs: number
  settled?: Promise<void>
  submitted?: () => boolean
}
