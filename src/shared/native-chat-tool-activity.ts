// Shared tool activity/copy for direct English mobile rows and desktop i18n fallbacks.

import { createToolInputDisplay } from './native-chat-tool-summary'
import { isToolCallBlock, type NativeChatBlock } from './native-chat-types'

type NativeChatToolCallBlock = Extract<NativeChatBlock, { type: 'tool-call' }>

export const NATIVE_CHAT_TOOL_ACTIVITY_COPY = {
  runningPreview: 'Running {{preview}}',
  runningCommand: 'Running command',
  runningNamedPreview: 'Running {{toolName}} {{preview}}',
  runningNamed: 'Running {{toolName}}',
  countOne: '1 tool call',
  countN: '{{value0}} tool calls',
  moreCalls: '+{{value0}} more',
  /** Count-neutral failure mark for settled collapsed headers; individual rows retain detail. */
  failedCount: '{{value0}} failed',
  /** Spoken form of the same mark — `1 failed` alone does not say failed what. */
  failedCallsLabel: 'Failed tool calls: {{value0}}',
  /** Calls a stop cut short, counted apart from failures in the same quiet mark. */
  interruptedCount: '{{value0}} interrupted',
  interruptedCallsLabel: 'Interrupted tool calls: {{value0}}'
} as const

/** Shell-command rows use terminal activity wording/glyphs rather than named-tool presentation. */
export const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'powershell',
  'terminal',
  'execute',
  'run_command',
  'run_shell_command',
  'shell_command',
  'exec_command',
  'run_terminal_cmd',
  'run_terminal_command'
])

export function isCommandToolName(name: string): boolean {
  return COMMAND_TOOL_NAMES.has(name.trim().toLowerCase())
}

export type NativeChatActiveToolDescriptor = {
  key: 'runningPreview' | 'runningCommand' | 'runningNamedPreview' | 'runningNamed'
  toolName: string
  preview: string
  isCommand: boolean
}

/** Which copy key and arguments the active-tool row renders for a running call. */
export function describeActiveToolCall(
  call: NativeChatToolCallBlock
): NativeChatActiveToolDescriptor {
  const preview = createToolInputDisplay(call.input).label
  const isCommand = isCommandToolName(call.name)
  const key = isCommand
    ? preview
      ? 'runningPreview'
      : 'runningCommand'
    : preview
      ? 'runningNamedPreview'
      : 'runningNamed'
  return { key, toolName: call.name, preview, isCommand }
}

/** Resolve the active-tool label in English. For platforms without i18n (mobile). */
export function formatActiveToolLabel(descriptor: NativeChatActiveToolDescriptor): string {
  return NATIVE_CHAT_TOOL_ACTIVITY_COPY[descriptor.key]
    .replaceAll('{{preview}}', descriptor.preview)
    .replaceAll('{{toolName}}', descriptor.toolName)
}

/** Tense-free command/tool arguments; surrounding activity text carries state so this never claims a just-finished call still runs. */
export function describeLatestToolCall(call: NativeChatToolCallBlock): string {
  const { toolName, preview, isCommand } = describeActiveToolCall(call)
  if (isCommand) {
    return preview || toolName
  }
  return preview ? `${toolName} ${preview}` : toolName
}

/** Newest active call; lifecycle-less blocks count only during a known working turn so restored orphan calls cannot spin forever. */
export function selectActiveToolCall(
  blocks: readonly NativeChatBlock[],
  { activeTurnIsWorking }: { activeTurnIsWorking?: boolean }
): NativeChatToolCallBlock | null {
  if (activeTurnIsWorking === false) {
    return null
  }
  const calls = blocks.filter(isToolCallBlock)
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]
    if (
      call &&
      (call.state === 'running' || (call.state == null && activeTurnIsWorking === true))
    ) {
      return call
    }
  }
  return null
}

/** Fallback summary when no per-tool summary is available. */
export function formatToolCallCount(callCount: number): string {
  return callCount === 1
    ? NATIVE_CHAT_TOOL_ACTIVITY_COPY.countOne
    : NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN.replaceAll('{{value0}}', String(callCount))
}
