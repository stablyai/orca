// Orca's own sentences for unreadable or failed agent CLI output; part of TEXT_GENERATION_FAILURE_COPY.
export const AGENT_OUTPUT_FAILURE_COPY = {
  openCodeInvalidEvents: 'OpenCode returned invalid JSON events.',
  antigravityInvalidEvents: 'Antigravity returned invalid JSON events.',
  antigravityInvalidResult: 'Antigravity returned an invalid result.',
  antigravityNoFinalResult: 'Antigravity returned no final result.',
  kimiUnreadableOutput: "Kimi returned output Orca couldn't read. Try again.",
  kimiSessionOccupied:
    "Kimi couldn't use this session because it is active in another client. Stop the session there or exit that client, then try again.",
  kimiInterrupted: 'Kimi was interrupted before it finished generating text. Try again.',
  kimiFailed:
    "Kimi couldn't finish generating text. Open Kimi on the execution host to check the failure before retrying.",
  kimiAgentOptionsConflict:
    'Kimi received conflicting or repeated agent options. Keep a single --agent or --agent-file option in the generation recipe or CLI arguments, then retry.',
  kimiOptionRejected:
    'Kimi rejected an option or argument. Correct the generation recipe or CLI arguments, then retry.',
  kimiSessionNotFound:
    "Kimi couldn't find the requested session. Use an existing session or start a new one.",
  kimiSessionOtherDirectory:
    'This Kimi session belongs to another directory. Resume it there or use a session created for this workspace.',
  kimiCredentialVariableMissing:
    'Kimi is missing a configured credential environment variable. Set it on the execution host before retrying.',
  kimiCredentialsRequired:
    'Kimi needs provider credentials. Open Kimi on the execution host to configure a provider or sign in, then retry.',
  kimiModelMissing:
    'Kimi has no usable model configured. Open Kimi on the execution host to configure or select a model, then retry.',
  kimiPromptHookBlocked:
    "A Kimi prompt hook blocked the request or the turn couldn't start. Review Kimi hooks and configuration before retrying.",
  kimiCancelled: 'Kimi cancelled the request before it finished generating text. Try again.',
  kimiEmptyPrompt:
    'Kimi received an empty prompt. Correct that input in the generation recipe or CLI arguments, then retry.',
  kimiEmptyModel:
    'Kimi received an empty model. Correct that input in the generation recipe or CLI arguments, then retry.',
  kimiEmptyAgent:
    'Kimi received an empty agent. Correct that input in the generation recipe or CLI arguments, then retry.',
  kimiEmptyAgentFilePath:
    'Kimi received an empty agent file path. Correct that input in the generation recipe or CLI arguments, then retry.',
  kimiOutputFormatInvalid:
    'Kimi output format requires prompt mode and a supported text or stream-json value. Correct the generation recipe or CLI arguments before retrying.',
  kimiSessionIdRequired:
    'Kimi needs a session id to resume in prompt mode. Correct the generation recipe or CLI arguments, then retry.',
  kimiConflictingOptions:
    'Kimi received conflicting options: {{option}} with {{otherOption}}. Correct the generation recipe or CLI arguments before retrying.',
  kimiContinueSessionConflict:
    'Kimi received conflicting options: --continue, --session. Correct the generation recipe or CLI arguments before retrying.',
  kimiAgentChangeOnResume:
    'Kimi cannot change the agent when resuming a session. Remove the agent override or start a new session in the generation recipe or CLI arguments.',
  kimiResponseBlocked:
    'Kimi could not return a response because it was blocked. Revise the prompt or model configuration before retrying.',
  kimiAuthFailed:
    'Kimi could not authenticate. Sign in or correct provider credentials on the execution host, then retry.',
  kimiConnectionFailed:
    'Kimi could not connect to its provider. Check the network on the execution host, then retry.',
  kimiProviderLimited:
    'Kimi reached a provider limit or the provider is busy. Wait before retrying or reduce request frequency.',
  kimiContextOverflow:
    'Kimi ran out of context. Shorten the prompt or start a new session, then retry.',
  kimiConfigInvalid:
    'Kimi has invalid configuration. Check the model and provider configuration on the execution host before retrying.'
} as const

export type AgentOutputFailureCode = keyof typeof AGENT_OUTPUT_FAILURE_COPY
