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
  read: (worktreeId: string, filePath: string) => Promise<string>
}

/** Set only inside the Background panel; the strip elsewhere keeps its rows as they are. */
export const ZotzBackgroundTaskOutputsContext = createContext<ZotzBackgroundTaskOutputs | null>(
  null
)

export function useZotzBackgroundTaskOutputs(): ZotzBackgroundTaskOutputs | null {
  return useContext(ZotzBackgroundTaskOutputsContext)
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

function collect(blocks: readonly NativeChatBlock[], into: Map<string, string>): void {
  for (const block of blocks) {
    if (isBackgroundTaskBlock(block)) {
      if (block.outputFile) {
        into.set(block.taskId, block.outputFile)
      }
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

/** Every task's latest output file in the chat's transcript, keyed by provider task id. */
export function useZotzTaskOutputFiles(
  messages: readonly NativeChatMessage[] | undefined
): ReadonlyMap<string, string> {
  return useMemo(() => {
    const outputFiles = new Map<string, string>()
    for (const message of messages ?? []) {
      collect(message.blocks, outputFiles)
    }
    return outputFiles
  }, [messages])
}
