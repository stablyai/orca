// Share whole English sentence pieces: the host interpolates them; desktop translates each with the same fallback.

import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
} from './claude-profile-routing'
import type { AgentSessionRefusalReference } from './agent-session-wire-refusals'
import type { AgentCliInstallationProblem } from './agent-cli-installation-problem'
import { tuiAgentDisplayName } from './tui-agent-display-names'

/** Sentences a refusal notice shows too, so a chat says them one way. */
export const TERMINAL_AGENT_HOLDS_CHAT = 'This chat is still open in a terminal agent.'
export const QUIT_TERMINAL_AGENT = 'Quit that agent to continue the chat here.'
export const START_NEW_CHAT = 'Start a new chat to continue.'
export const BACKGROUND_TASKS_RUNNING = 'Background tasks are still running.'
export const WAIT_FOR_BACKGROUND_TASKS = 'Wait for the background tasks to finish.'
export const AGENT_STARTING = 'The agent is still starting.'
export const WAIT_FOR_START = 'Wait for the agent to finish starting.'
export const AGENT_STILL_WORKING = 'The agent is still working.'

/** Whole translatable pieces; the host fills agent (name or theAgent) and command (conversation command name) in English. */
export const AGENT_SESSION_FAILURE_COPY = {
  theAgent: 'The agent',
  providerStartFailed: '{{agent}} stopped before it finished starting.',
  runCommandAgain: 'Run /{{command}} again.',
  sendToTryAgain: 'Send your message to try again.',
  sendAgainToTryOnceMore: 'Send your message again to try once more.',
  couldNotStart: "{{agent}} couldn't start.",
  couldNotRestart: "{{agent}} couldn't restart.",
  cliTooOld:
    '{{agent}} {{installedVersion}} is too old for chats. Update to {{minimumVersion}} or newer.',
  startTimedOut: '{{agent}} took too long to start (no response to {{method}} after {{seconds}}s).',
  startTimedOutKeepsHappening:
    'If this keeps happening, the computer running this chat may be overloaded.',
  argumentsUnsupportedOption: 'Saved Arguments contain an unsupported option ({{option}}).',
  argumentsMissingValue: 'Saved Arguments need a value for {{option}}.',
  argumentsMultipleValues: 'Saved Arguments give {{option}} more than one value.',
  argumentsPositionalPrompt: 'Saved Arguments include a prompt.',
  editSavedArguments: 'Edit them in Settings > Agents > Arguments.',
  terminalAgentHoldsChat: TERMINAL_AGENT_HOLDS_CHAT,
  quitTerminalAgent: QUIT_TERMINAL_AGENT,
  startNewChat: START_NEW_CHAT,
  notSignedIn: '{{agent}} is not signed in.',
  claudeSystemNotSignedIn:
    "Claude isn't signed in. Run `{{loginCommand}}`, or choose an account in Claude Accounts settings.",
  claudeManagedNotSignedIn:
    "This Claude account isn't signed in. Sign in again in Claude Accounts settings.",
  codexSystemNotSignedIn: "Codex isn't signed in. Run `{{loginCommand}}`.",
  codexManagedNotSignedIn:
    "This Codex account isn't signed in. Sign in again in Codex Accounts settings.",
  antigravityNotSignedIn:
    "Antigravity isn't signed in. Sign in under Settings → Accounts → Antigravity. Then send your message again.",
  agentCommandNotSignedIn:
    'Sign in to {{agent}} with `{{loginCommand}}` on the computer running this chat.',
  interactiveAgentNotSignedIn:
    'Sign in to {{agent}} by running `{{loginCommand}}` and using `{{slashCommand}}` on the computer running this chat.',
  agentNotSignedIn: 'Sign in to {{agent}}.',
  cliMissing:
    "{{agent}} wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents.",
  signInFirst: 'Sign in first.',
  signInThenRunCommand: 'Sign in, then run /{{command}} again.',
  signInThenSend: 'Sign in, then send your message again.',
  thenSendAgain: 'Then send your message again.',
  historyTooLarge: "This conversation's history is too large to restore here.",
  managedAccountEnvOverride:
    'This Claude launch sets its own Anthropic sign-in variables. Remove them to use a managed Claude account.',
  accountSwitchInProgress:
    "{{agent}}'s setup is changing on this host. Try again after it finishes.",
  managedAccountUnsupported:
    'While a Claude account is added in WSL, Claude chats need a Windows Claude account.',
  launchFolderMissing:
    'The folder this chat ran in no longer exists. Restore it to continue this chat.',
  historyInOtherAccount:
    "This chat's history is in another Claude account. Switch back to that account to continue it.",
  claudeAccountFolderMissing: CLAUDE_PROFILE_MISSING_MESSAGE,
  claudeAccountSetupFailed: CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  agentCommandNotRunnable:
    "{{agent}}'s Command in Settings → Agents must be a program path or name Orca can find, with no arguments or variables. Change it or reset it.",
  runtimeNotInstalled:
    "{{agent}} isn't installed on the computer running this chat. Install it from the chat in a current version of Orca.",
  fullAccessAsRoot:
    "{{agent}} won't use Full access while it runs as root. Choose another permission for {{agent}} in Settings → Agents for the computer running this chat, then start a new chat.",
  conversationOpenElsewhere:
    'Codex is still holding this conversation open. Try again in a moment, or close other Codex terminals.',
  conversationOpenInTerminal:
    '{{agent}} is already running this conversation in another terminal. Quit {{agent}} there or close that terminal to continue here.',
  chooseClaudeAccount: 'Choose or add one in Claude Accounts settings.',
  chooseClaudeAccountThenRunCommand:
    'Choose or add one in Claude Accounts settings, then run /{{command}} again.',
  chooseClaudeAccountThenSend:
    'Choose or add one in Claude Accounts settings, then send your message again.',
  providerExitedRow:
    '{{agent}} stopped while this response was in progress. You can continue in this conversation.',
  providerExitedRejection: '{{agent}} stopped before this message was sent.',
  providerExitedAnswer:
    '{{agent}} has stopped, so your answer was not sent. Send a message to continue.',
  providerRejected: "{{agent}} didn't accept this message.",
  providerRejectedQuoted: "{{agent}} didn't accept this message: {{detail}}.",
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
  commandUnavailable: "This command isn't available in {{agent}} chats, so it was not sent.",
  queueFull: 'Too many messages were waiting for the agent, so this one was not sent.',
  writeFailed: "Orca couldn't hand this message to the agent, so it was not sent.",
  cancelled: 'This message was withdrawn before the agent started it.',
  chatClosed: 'The chat closed before this message was sent.',
  hostRestarted: 'Orca restarted before this message was sent.',
  notDelivered: 'This message was not delivered.',
  notDeliveredSendAgain: 'This message was not delivered. Send it again to continue.',
  commandRefused: "This command didn't run.",
  commandRefusedTryAgain: "This command didn't run. Try it again.",
  // What kept a command from running, in the words its refusal has everywhere.
  backgroundTasksRunning: BACKGROUND_TASKS_RUNNING,
  waitForBackgroundTasks: WAIT_FOR_BACKGROUND_TASKS,
  agentStarting: AGENT_STARTING,
  waitForStart: WAIT_FOR_START,
  agentStillWorking: AGENT_STILL_WORKING,
  runCommandWhenDone: "Run /{{command}} when it's done.",
  commandAfterAnswer: "Answer the agent's question or approval, then run /{{command}}.",
  compactionFailed: 'Compaction failed.',
  compactionFailedQuoted: 'Compaction failed: {{detail}}.',
  compactionUnconfirmed: 'Compaction completion is unconfirmed.',
  cancelUnconfirmed: 'Cancellation was not confirmed.',
  stopRefused: "{{agent}} didn't stop.",
  stopRefusedQuoted: "{{agent}} didn't stop: {{detail}}.",
  couldNotStop: "Couldn't stop {{agent}}.",
  couldNotStopTheAgent: "Couldn't stop the agent.",
  noTurnToStop: '{{agent}} had no turn running to stop.',
  backgroundTaskNotStopped: "The background task wasn't stopped.",
  backgroundTasksNotStopped: "The background tasks weren't stopped.",
  answerUnconfirmed: 'Your answer was recorded but the agent did not confirm it.',
  hostFault: "Orca ran into a problem, so this didn't go through.",
  hostFaultTryAgain: "Orca ran into a problem, so this didn't go through. Try again.",
  hostStopped: '{{agent}} never finished starting, so Orca stopped it.',
  providerRateLimited: '{{agent}} is rate-limited and retrying.',
  providerRetrying: '{{agent}} hit a temporary problem and is retrying.',
  providerRetryingQuoted: '{{agent}} is retrying: {{detail}}.',
  providerRetryNumber: 'Retry {{attempt}}.',
  providerRetryNumberOf: 'Retry {{attempt}} of {{maxRetries}}.',
  providerRetryLastError: 'Last error: {{detail}}.',
  usageLimitReached: '{{agent}} hit its usage limit.',
  usageLimitReachedNamed: '{{agent}} hit its {{window}} limit.',
  usageLimitWindowSession: 'session',
  usageLimitWindowWeekly: 'weekly',
  usageLimitWindowWeeklyModel: 'weekly model',
  usageLimitWindowCredits: 'extra usage',
  usageLimitResetsAt: 'It resets at {{when}}.',
  usageLimitSendAfterReset: 'Send a message once it resets to continue.',
  previousExitUnverifiable: "Couldn't stop {{agent}} from before.",
  sessionNotRestored:
    "{{agent}} couldn't reopen its earlier session, so this chat continues in a new one. {{agent}} doesn't remember the earlier messages."
} as const

export type AgentSessionFailureCopyId = keyof typeof AGENT_SESSION_FAILURE_COPY

export type AgentSessionFailureCopyValues = {
  installedVersion?: string
  minimumVersion?: string
  agent?: string
  command?: string
  loginCommand?: string
  slashCommand?: string
  detail?: string
  /** A usage limit's name, from the `usageLimitWindow*` pieces. */
  window?: string
  /** When a usage limit resets, in the reader's clock. */
  when?: string
  option?: string
  limit?: string
  size?: string
  attempt?: string
  maxRetries?: string
  /** A provider protocol method that got no answer, e.g. `thread/start`. */
  method?: string
  seconds?: string
}

export type AgentSessionFailureSay = (
  id: AgentSessionFailureCopyId,
  values?: AgentSessionFailureCopyValues
) => string

export function agentCliTooOldWords(
  { agent, installedVersion, minimumVersion }: AgentCliInstallationProblem,
  say: AgentSessionFailureSay
): string {
  return say('cliTooOld', {
    agent: tuiAgentDisplayName(agent) ?? agent,
    installedVersion,
    minimumVersion
  })
}

/** A refusal's installation sentence; a refusal saved before `agentInstallation` is Codex's. */
export function agentCliInstallationFailureWords(
  refusal: AgentSessionRefusalReference | undefined,
  say: AgentSessionFailureSay
): string | null {
  if (refusal?.code !== 'agent_session_operation_invalid') {
    return null
  }
  const { agentInstallation, codexInstallation } = refusal.details ?? {}
  if (agentInstallation) {
    return agentCliTooOldWords(agentInstallation, say)
  }
  if (!codexInstallation) {
    return null
  }
  const { installedVersion, minimumVersion } = codexInstallation
  return installedVersion === null
    ? say('cliMissing', { agent: 'Codex' })
    : agentCliTooOldWords({ agent: 'codex', installedVersion, minimumVersion }, say)
}

/** The host's words, and any surface without translations. */
export const sayAgentSessionFailureEnglish: AgentSessionFailureSay = (id, values = {}) => {
  const filled = new Map(Object.entries(values))
  // One pass over the template, so a provider's words are never read as a placeholder.
  return AGENT_SESSION_FAILURE_COPY[id].replace(
    /\{\{(\w+)\}\}/g,
    (placeholder, name: string) => filled.get(name) ?? placeholder
  )
}
