// Share formatting options across desktop/phone while retaining each reader’s locale.

/** The time under a message: "3:42 PM". */
export const NATIVE_CHAT_MESSAGE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit'
}

/** The same time, spoken in full for a screen reader. */
export const NATIVE_CHAT_MESSAGE_FULL_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  dateStyle: 'full',
  timeStyle: 'long'
}
