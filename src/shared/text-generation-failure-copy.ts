// One English table for AI text-generation failures: main builds the wire `error`, the renderer translates by code.
export const TEXT_GENERATION_FAILURE_COPY = {
  promptTooLargeForWindows:
    '{{label}} prompt is too large for the Windows command line. Stage fewer changes and try again.',
  promptTooLargeForArgument:
    '{{label}} prompt is too large to pass as a single command-line argument. Stage fewer changes and try again.',
  agentCouldNotStart:
    '{{label}} could not be started. Check the agent command in Settings and try again.',
  agentFailedToStart:
    '{{label}} failed to start. Check the agent command in Settings and try again.',
  agentBinaryNotFound: '{{binary}} not found on PATH. Install {{label}} to use AI commit messages.',
  timedOut: 'Generation timed out after {{seconds}}s.',
  outputTooLarge:
    '{{label}} CLI command produced too much output. Check the agent CLI configuration and try again.',
  windowsBatchUnsafeArguments:
    "{{label}} runs through a Windows batch script that cannot take the multi-line prompt as an argument. Point Settings at the agent's executable, or use a custom command without {prompt} so Orca sends the prompt on stdin.",
  cliTerminated: '{{label}} CLI command was terminated before exiting.',
  cliTerminatedWithDetail: '{{label}} CLI command was terminated before exiting: {{detail}}',
  cliFailed: '{{label}} CLI command failed with code {{exitCode}}.',
  cliFailedWithDetail: '{{label}} CLI command failed with code {{exitCode}}: {{detail}}',
  agentReportedError: '{{label}} reported an error.',
  emptyCommitMessage: '{{label}} returned an empty message.',
  emptyCommitMessageWithDetail: '{{label}} returned an empty message. CLI output: {{detail}}',
  emptyPullRequestDetails: '{{label}} returned an empty details.',
  emptyPullRequestDetailsWithDetail: '{{label}} returned an empty details. CLI output: {{detail}}',
  emptyJiraSummary: '{{label}} returned an empty summary.',
  emptyJiraSummaryWithDetail: '{{label}} returned an empty summary. CLI output: {{detail}}',
  commitMessageUnparseable: 'Generated commit message could not be parsed.',
  pullRequestDetailsUnparseable: 'Generated pull request details could not be parsed.',
  jiraSummaryEmptyAfterSanitization: 'Generated summary was empty after sanitization.',
  jiraDescriptionRequired: 'Description is required.',
  jiraAccountDisconnected: 'Reconnect the selected Jira account on this host.',
  jiraSummaryBusyInOtherDraft: 'A Jira title is already being generated in another draft.',
  stagedChangesReadFailed: 'Failed to read staged changes.',
  noStagedChanges: 'No staged changes to summarize.',
  noBranchChanges: 'No branch changes to summarize.',
  commandTemplateEmptyCommitMessage: 'Command template is empty for commit messages.',
  commandTemplateEmptyPullRequest: 'Command template is empty for pull request details.',
  commandTemplateEmptyBranchName: 'Command template is empty for branch names.',
  commandTemplateEmptyChatName: 'Command template is empty for chat names.',
  sourceControlAgentUnsupported:
    'Choose a supported Source Control AI agent for this action in Settings -> Git -> Source Control AI. Supported agents: {{agents}}, or Custom command.',
  chatNameAgentUnsupported:
    'Choose a supported chat name agent for this action in Settings -> Chat -> Chat names. Supported agents: {{agents}}, or Custom command.',
  sourceControlCustomCommandEmpty:
    'Custom command is empty. Add one in Settings -> Git -> Source Control AI.',
  chatNameCustomCommandEmpty: 'Custom command is empty. Add one in Settings -> Chat -> Chat names.',
  agentCannotGenerateCommitMessage:
    'Agent "{{agent}}" does not support Source Control AI commit messages. Supported agents: {{agents}}, or Custom command.',
  agentCannotGeneratePullRequest:
    'Agent "{{agent}}" does not support Source Control AI pull request details. Supported agents: {{agents}}, or Custom command.',
  agentCannotGenerateBranchName:
    'Agent "{{agent}}" does not support Source Control AI branch names. Supported agents: {{agents}}, or Custom command.',
  agentCannotGenerateChatName:
    'Agent "{{agent}}" does not support chat names. Supported agents: {{agents}}, or Custom command.',
  noModelForAgent: 'No model is available for {{label}}.',
  planCustomCommandEmpty:
    'Custom command is empty. Add one in Settings → Git → AI Commit Messages.',
  planAgentUnsupported: 'Agent "{{agent}}" does not support AI commit messages.',
  planModelUnavailable: 'Model "{{model}}" is not available for {{label}}.',
  planModelWithoutThinking: 'Model "{{model}}" does not support a thinking effort level.',
  planThinkingLevelInvalid: 'Thinking level "{{level}}" is not valid for {{model}}.'
} as const

export type TextGenerationFailureCode = keyof typeof TEXT_GENERATION_FAILURE_COPY

type TemplateSlots<S extends string> = S extends `${string}{{${infer Slot}}}${infer Rest}`
  ? Slot | TemplateSlots<Rest>
  : never

export type TextGenerationFailureValues<C extends TextGenerationFailureCode> = Record<
  TemplateSlots<(typeof TEXT_GENERATION_FAILURE_COPY)[C]>,
  string | number
>

/** Wire fields: `error` stays English for older clients; `errorDetail` is verbatim agent CLI output. */
export type TextGenerationFailureFields = {
  error: string
  errorCode?: string
  errorParams?: Record<string, string | number>
  errorDetail?: string
}

const SLOT_PATTERN = /\{\{(\w+)\}\}/g

export function textGenerationFailure<C extends TextGenerationFailureCode>(
  errorCode: C,
  ...[values]: TemplateSlots<(typeof TEXT_GENERATION_FAILURE_COPY)[C]> extends never
    ? []
    : [TextGenerationFailureValues<C>]
): TextGenerationFailureFields {
  const slots: Record<string, string | number> = values ?? {}
  // One pass so a label or detail containing "{{...}}" stays verbatim.
  const error = TEXT_GENERATION_FAILURE_COPY[errorCode].replace(SLOT_PATTERN, (_match, slot) =>
    String(slots[slot] ?? '')
  )
  const { detail, ...params } = slots
  return {
    error,
    errorCode,
    ...(Object.keys(params).length > 0 ? { errorParams: params } : {}),
    ...(detail !== undefined ? { errorDetail: String(detail) } : {})
  }
}

/** Carries the coded fields across result rebuilds without copying absent keys. */
export function textGenerationFailureCodeFields(
  failure: Omit<TextGenerationFailureFields, 'error'>
): Omit<TextGenerationFailureFields, 'error'> {
  return {
    ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
    ...(failure.errorParams !== undefined ? { errorParams: failure.errorParams } : {}),
    ...(failure.errorDetail !== undefined ? { errorDetail: failure.errorDetail } : {})
  }
}
