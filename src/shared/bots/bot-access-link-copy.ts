// Why an owner's "Review in Orca" link didn't open, in English: the desktop's translate fallbacks and the phone's text.

export const BOT_ACCESS_LINK_COPY = {
  notOwner: 'This request is for another Orca account. Sign in as the bot’s owner to review it.',
  expired:
    'This request was already opened or has expired. Open the bot’s settings to see what is waiting.',
  failed: 'Couldn’t open this request. Check your connection, then try again.',
  notHere:
    'This request is for a bot on another computer. Open the link on the computer that runs it.',
  // A phone's host without the routes: the owner's computer can still open it.
  unsupportedFromPhone: 'Review this request in Orca on your computer.'
} as const
