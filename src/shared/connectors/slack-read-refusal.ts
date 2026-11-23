// Slack uses these stable refusal codes for different read-access conditions.
export function slackReadRefusalMessage(reason: string | null): string | null {
  const error = reason?.toLowerCase()
  if (!error) {
    return null
  }
  if (/missing(?:_| )scope/.test(error)) {
    return 'Slack refused this read because the bot app is missing channel-history permission. Reconnect the bot to Slack so it grants `channels:history` for public channels and `groups:history` for private channels, then try again.'
  }
  if (/not_in_channel/.test(error)) {
    return 'Slack refused this read because the bot is not in that channel. Run `orca slack check <channel> --join` for a public channel, or invite the bot to a private channel, then try again.'
  }
  if (/channel_not_found/.test(error)) {
    return "Slack couldn't find a channel this bot can read. Check that the link is for this Slack workspace; for a private channel, invite the bot first."
  }
  if (/thread_not_found/.test(error)) {
    return "Slack couldn't find that thread. Read it from the thread's root message or use `orca slack find <channel>` to get a current ref."
  }
  return null
}
