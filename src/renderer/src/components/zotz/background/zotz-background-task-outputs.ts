import { createContext, useContext, useMemo } from 'react'
import {
  isBackgroundTaskBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../../../../shared/native-chat/native-chat-types'

export type ZotzBackgroundTaskOutputs = {
  /** The chat's worktree, whose host owns the output files. */
  worktreeId: string | null
  /** Provider task id → where the provider writes that task's output. */
  outputFiles: ReadonlyMap<string, string>
  /** What each tool call has printed so far, from the chat itself, for agents that write no output file. */
  callOutputs: ZotzCallOutputs
  read: (worktreeId: string, filePath: string) => Promise<string>
}

/** Set only inside the Background panel; the strip elsewhere keeps its rows as they are. */
export const ZotzBackgroundTaskOutputsContext = createContext<ZotzBackgroundTaskOutputs | null>(
  null
)

export function useZotzBackgroundTaskOutputs(): ZotzBackgroundTaskOutputs | null {
  return useContext(ZotzBackgroundTaskOutputsContext)
}

export type ZotzCallOutputs = {
  /** Tool call id → its latest output text. */
  byCall: ReadonlyMap<string, string>
  /** Provider task id → the tool call that launched it. */
  callByTask: ReadonlyMap<string, string>
}

type Collected = {
  outputFiles: Map<string, string>
  byCall: Map<string, string>
  callByTask: Map<string, string>
}

const CODEX_PRIMARY_COMMAND_PREFIX = 'codex-command:primary:'

function codexCommandCallId(taskId: string): string | null {
  if (!taskId.startsWith(CODEX_PRIMARY_COMMAND_PREFIX)) {
    return null
  }
  try {
    return decodeURIComponent(taskId.slice(CODEX_PRIMARY_COMMAND_PREFIX.length))
  } catch {
    return null
  }
}

/** The shell's output as the chat shows it; null when no call in the transcript is linked to the task. */
export function zotzTaskCallOutput(outputs: ZotzCallOutputs, taskId: string): string | null {
  const callId = outputs.callByTask.get(taskId) ?? codexCommandCallId(taskId)
  if (!callId) {
    return null
  }
  return outputs.byCall.get(callId) ?? (outputs.callByTask.has(taskId) ? '' : null)
}

function isBlockList(value: unknown): value is NativeChatBlock[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => typeof item === 'object' && item !== null && typeof item.type === 'string'
    )
  )
}

function collect(blocks: readonly NativeChatBlock[], into: Collected): void {
  for (const block of blocks) {
    if (isBackgroundTaskBlock(block)) {
      if (block.outputFile) {
        into.outputFiles.set(block.taskId, block.outputFile)
      }
      if (block.parentToolUseId) {
        into.callByTask.set(block.taskId, block.parentToolUseId)
      }
      continue
    }
    if (block.type === 'tool-result' && block.callId) {
      into.byCall.set(block.callId, block.output)
      continue
    }
    // Task rows can sit inside a tool run's own blocks.
    for (const value of Object.values(block)) {
      if (isBlockList(value)) {
        collect(value, into)
      }
    }
  }
}

/** Every task's latest output file, plus each tool call's output, from the chat's transcript. */
export function useZotzTaskOutputSources(messages: readonly NativeChatMessage[] | undefined): {
  outputFiles: ReadonlyMap<string, string>
  callOutputs: ZotzCallOutputs
} {
  return useMemo(() => {
    const collected: Collected = {
      outputFiles: new Map(),
      byCall: new Map(),
      callByTask: new Map()
    }
    for (const message of messages ?? []) {
      collect(message.blocks, collected)
    }
    const { outputFiles, byCall, callByTask } = collected
    return { outputFiles, callOutputs: { byCall, callByTask } }
  }, [messages])
}
