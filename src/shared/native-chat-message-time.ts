// How a chat message's time reads: desktop formats it in the reader's locale, the phone in the
// device's, with the same options so the two never disagree on what a message's time looks like.

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
