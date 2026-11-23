// Slack uses these stable refusal codes for different read-access conditions.
export function slackReadRefusalMessage(reason: string | null): string | null {
  const error = reason?.toLowerCase().trim() ?? ''
  switch (error) {
    case 'slack_history_scope_missing':
      return 'Slack refused this read because the bot app is missing channel-history permission. Reconnect the bot to Slack so it grants `channels:history` for public channels and `groups:history` for private channels, then try again.'
    case 'slack_channel_not_joined':
      return 'Slack refused this read because the bot is not in that channel. Run `orca slack check <channel> --join` for a public channel, or invite the bot to a private channel, then try again.'
    case 'slack_channel_not_visible':
      return "Slack couldn't find a channel this bot can read. Check that the link is for this Slack workspace; for a private channel, invite the bot first."
    case 'slack_thread_not_found':
      return "Slack couldn't find that thread. Read it from the thread's root message or use `orca slack find <channel>` to get a current ref."
    case 'slack_file_not_found':
      return "Slack couldn't find that file on the message. Read the message again to get its current file ids."
    default:
      return null
  }
}
