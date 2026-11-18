/** Links must come from the session owner's host, never another host's catalog. */
export function botOwnsChatSession(
  bot: { id: string; chatSessionId?: string | null },
  sessionId: string | null,
  links: readonly unknown[] = []
): boolean {
  return (
    sessionId !== null &&
    (bot.chatSessionId === sessionId ||
      links.some(
        (link) =>
          link !== null &&
          typeof link === 'object' &&
          'sessionId' in link &&
          link.sessionId === sessionId &&
          'bot' in link &&
          link.bot !== null &&
          typeof link.bot === 'object' &&
          'botId' in link.bot &&
          link.bot.botId === bot.id
      ))
  )
}
