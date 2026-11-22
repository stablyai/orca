// Why: older hosts lack the targeted settings RPCs and strip agentPrompt from
// terminal creation, so mobile must hide Quick Commands unless both are present.
export const TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY = 'terminal.quick-commands.v1' as const
// Legacy builds reject a whole list containing prompts over 6000 characters. Advertise storage/read support so hosts withhold long prompts from older clients. Remove when those builds age out.
export const TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY =
  'terminal.quick-commands.long-prompts.v1' as const

// Older clients reject lists above forty; publish only a readable subset to them.
export const LEGACY_MAX_QUICK_COMMANDS = 40
export const TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY =
  'terminal.quick-commands.large-lists.v1' as const

export const TERMINAL_QUICK_COMMAND_RUNTIME_CAPABILITIES = [
  TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY
] as const
