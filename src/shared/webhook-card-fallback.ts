// What shows in place of the webhook card where it can't render: a connector thread, or the phone in v1.
// It says where the URL is, never the URL or key.

export type WebhookCardNames = { automationName: string; botName: string }

/** The host's text for a hook, with its names; without them (the phone), the same steps unnamed. */
export function webhookCardFallbackText(names: WebhookCardNames | null): string {
  if (!names) {
    return 'This webhook is live. Copy its URL from Orca on a computer, in the bot’s settings under Webhooks. To pause or delete it, ask the bot here.'
  }
  const { automationName, botName } = names
  return `Webhook “${automationName}” is live. Copy its URL from Orca on a computer: Settings › Bots › ${botName} › Webhooks. To pause or delete it, ask ${botName} here.`
}
