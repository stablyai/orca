export const AGENT_SESSION_FAILURE_KINDS = [
  /** Only an observed exit: the provider stopped while starting. */
  'providerStartFailed',
  'providerResumeUnavailable',
  'savedConversationMissing',
  /** A start that did not land, with no one to blame: Orca's fault, a failed spawn, a close. */
  'startFailed',
  'notSignedIn',
  /** The agent's CLI is not installed where the chat runs: its spawn found no such file. */
  'cliMissing',
  'historyTooLarge',
  'managedAccountEnvOverride',
  'accountSwitchInProgress',
  'managedAccountUnsupported',
  'launchFolderMissing',
  'historyInOtherAccount',
  'claudeAccountFolderMissing',
  'claudeAccountSetupFailed',
  'agentCommandNotRunnable',
  'runtimeNotInstalled',
  /** The agent refuses Full access while it runs as root. */
  'fullAccessAsRoot',
  /** Orca's own launch preparation on the host failed before any agent process was spawned. */
  'launchPreparationFailed',
  'conversationOpenInTerminal',
  'conversationOpenElsewhere',
  'providerExited',
  'restartFailed',
  'providerRejected',
  'pluginInputRequired',
  'modelUnavailable',
  'modelNotSelected',
  'claudeEffortInvalid',
  'attachmentInvalid',
  'attachmentUnreadable',
  'emptyMessage',
  /** One of the agent's own commands that its chats do not run, sent as a whole message. */
  'commandUnavailable',
  'queueFull',
  'writeFailed',
  'cancelled',
  'chatClosed',
  'hostRestarted',
  'notDelivered',
  'unconfirmed',
  /** A conversation command the chat's state refused when its turn to run came. */
  'commandRefused',
  'compactionFailed',
  'compactionUnconfirmed',
  'cancelUnconfirmed',
  /** A Stop naming no turn reached the agent, which ended nothing while the chat read working. */
  'stopRefused',
  /** A Stop Orca could not save: only a refusal says it. */
  'stopFailed',
  /** A background-task Stop the agent answered with the task still running. */
  'backgroundTaskNotStopped',
  'answerUnconfirmed',
  'hostFault',
  /** Orca stopped an agent whose start never finished. */
  'hostStopped',
  /** The provider is retrying a request its API refused; not a failure yet. */
  'providerRetrying',
  /** The account hit one of the agent's usage limits, which ended the turn until it resets. */
  'usageLimitReached',
  /** A child a Stop could not prove gone: its exit is unverifiable. Kept for rows hosts wrote. */
  'previousExitUnverifiable',
  /** The agent could not reopen the chat's saved session, so a fresh one without its memory continues it. */
  'sessionNotRestored'
] as const
export type AgentSessionFailureKind = (typeof AGENT_SESSION_FAILURE_KINDS)[number]
