/** One opening of the picker, asked for by a slash command. */
export type NativeChatOptionPickerRequest = {
  id: string
  /** Drops the request once the picker has seen it, whether or not it could open. */
  consume: () => void
}
