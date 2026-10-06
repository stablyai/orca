// The pieces every failure sentence is made of, in English. The host fills them in as they are;
// desktop translates each piece whole with this as its fallback, so the two never differ.

/** Sentences a refusal notice shows too, so a chat says them one way. */
export const TERMINAL_AGENT_HOLDS_CHAT = 'This chat is still open in a terminal agent.'
export const QUIT_TERMINAL_AGENT = 'Quit that agent to continue the chat here.'
export const START_NEW_CHAT = 'Start a new chat to continue.'

/** Every piece a failure sentence is made of, whole so desktop can translate each on its own.
 *  `{{agent}}` is the agent's name or `theAgent`, `{{command}}` a conversation command's name; the
 *  host fills them in English. */
export const AGENT_SESSION_FAILURE_COPY = {
  theAgent: 'The agent',
  providerStartFailed: '{{agent}} stopped before it finished starting.',
  runCommandAgain: 'Run /{{command}} again.',
  sendToTryAgain: 'Send your message to try again.',
  sendAgainToTryOnceMore: 'Send your message again to try once more.',
  couldNotStart: "{{agent}} couldn't start.",
  couldNotRestart: "{{agent}} couldn't restart.",
  argumentsUnsupportedOption: 'Saved Arguments contain an unsupported option ({{option}}).',
  argumentsMissingValue: 'Saved Arguments need a value for {{option}}.',
  argumentsMultipleValues: 'Saved Arguments give {{option}} more than one value.',
  argumentsPositionalPrompt: 'Saved Arguments include a prompt.',
  editSavedArguments: 'Edit them in Settings > Agents > Arguments.',
  terminalAgentHoldsChat: TERMINAL_AGENT_HOLDS_CHAT,
  quitTerminalAgent: QUIT_TERMINAL_AGENT,
  startNewChat: START_NEW_CHAT,
  notSignedIn: '{{agent}} is not signed in for the selected account.',
  signInFirst: 'Sign in first.',
  signInThenRunCommand: 'Sign in, then run /{{command}} again.',
  signInThenSend: 'Sign in, then send your message again.',
  historyTooLarge: "This conversation's history is too large to restore here.",
  managedAccountEnvOverride:
    'This Claude launch sets its own Anthropic sign-in variables. Remove them to use a managed Claude account.',
  accountSwitchInProgress: 'A Claude account switch is in progress. Try again after it finishes.',
  managedAccountUnsupported:
    'While a Claude account is added in WSL, Claude chats need a Windows Claude account.',
  launchFolderMissing:
    'The folder this chat ran in no longer exists. Restore it to continue this chat.',
  chooseClaudeAccount: 'Choose or add one in Claude Accounts settings.',
  chooseClaudeAccountThenRunCommand:
    'Choose or add one in Claude Accounts settings, then run /{{command}} again.',
  chooseClaudeAccountThenSend:
    'Choose or add one in Claude Accounts settings, then send your message again.',
  providerExitedRow:
    '{{agent}} stopped while this response was in progress. You can continue in this conversation.',
  providerExitedRejection: '{{agent}} stopped before this message was sent.',
  providerRejected: 'The provider did not accept this message.',
  providerRejectedQuoted: 'The provider did not accept this message: {{detail}}.',
  attachmentEmpty: 'An image on this message is empty, so the message was not sent.',
  attachmentTooLarge: 'An image on this message is too large, so the message was not sent.',
  attachmentLargerThan:
    'An image on this message is larger than {{size}} MB, so the message was not sent.',
  attachmentTooMany: 'This message has too many images, so it was not sent.',
  attachmentAtMost:
    '{{agent}} accepts at most {{limit}} images in one message, so this message was not sent.',
  attachmentTotalTooLarge:
    'The images on this message are too large together, so the message was not sent.',
  attachmentTotalMoreThan:
    'The images on this message add up to more than {{size}} MB, so the message was not sent.',
  attachmentUnsupportedType:
    '{{agent}} accepts only PNG, JPEG, GIF, and WebP images, so this message was not sent.',
  attachmentNotAFile: "An image on this message isn't a file, so the message was not sent.",
  attachmentNoSource: 'An image on this message has no file to send, so the message was not sent.',
  attachmentInvalid: "An attachment on this message can't be sent to the agent.",
  attachmentUnreadable:
    "An attachment on this message couldn't be read, so the message was not sent.",
  emptyMessage: 'This message is empty, so it was not sent.',
  queueFull: 'Too many messages were waiting for the agent, so this one was not sent.',
  writeFailed: "Orca couldn't hand this message to the agent, so it was not sent.",
  cancelled: 'This message was withdrawn before the agent started it.',
  chatClosed: 'The chat closed before this message was sent.',
  hostRestarted: 'Orca restarted before this message was sent.',
  notDelivered: 'This message was not delivered.',
  notDeliveredSendAgain: 'This message was not delivered. Send it again to continue.',
  commandRefused: "This command didn't run.",
  commandRefusedTryAgain: "This command didn't run. Try it again.",
  compactionFailed: 'Compaction failed.',
  compactionFailedQuoted: 'Compaction failed: {{detail}}.',
  compactionUnconfirmed: 'Compaction completion is unconfirmed.',
  cancelUnconfirmed: 'Cancellation was not confirmed.',
  stopRefused: "{{agent}} didn't stop.",
  stopRefusedQuoted: "{{agent}} didn't stop: {{detail}}.",
  noTurnToStop: '{{agent}} had no turn running to stop.',
  answerUnconfirmed: 'Your answer was recorded but the agent did not confirm it.',
  hostFault: "Orca ran into a problem, so this didn't go through.",
  hostFaultTryAgain: "Orca ran into a problem, so this didn't go through. Try again.",
  hostStopped: '{{agent}} never finished starting, so Orca stopped it.',
  providerRateLimited: '{{agent}} is rate-limited and retrying.',
  providerRetrying: '{{agent}} hit a temporary problem and is retrying.',
  providerRetryingQuoted: '{{agent}} is retrying: {{detail}}.',
  previousExitUnverifiable: "Couldn't stop {{agent}} from before."
} as const

export type AgentSessionFailureCopyId = keyof typeof AGENT_SESSION_FAILURE_COPY

/** What a piece's `{{name}}` placeholders stand for. */
export type AgentSessionFailureCopyValues = {
  agent?: string
  command?: string
  detail?: string
  option?: string
  limit?: string
  size?: string
}

/** One piece in the reader's language, placeholders filled. */
export type AgentSessionFailureSay = (
  id: AgentSessionFailureCopyId,
  values?: AgentSessionFailureCopyValues
) => string

/** The host's words, and any surface without translations. */
export const sayAgentSessionFailureEnglish: AgentSessionFailureSay = (id, values = {}) => {
  const filled = new Map(Object.entries(values))
  // One pass over the template, so a provider's words are never read as a placeholder.
  return AGENT_SESSION_FAILURE_COPY[id].replace(
    /\{\{(\w+)\}\}/g,
    (placeholder, name: string) => filled.get(name) ?? placeholder
  )
}
