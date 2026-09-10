import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { buildDiffSummaries } from './native-chat-edit-cards'

export type NativeChatDiffTarget = {
  messageId: string
  editKey: string
  fileIndex: number
}

export type NativeChatDiffReveal = NativeChatDiffTarget & { requestId: number }

export type NativeChatTurnDiffFile = {
  path: string
  added: number
  removed: number
  truncated: boolean
  target: NativeChatDiffTarget
}

export type NativeChatTurnDiff = {
  files: NativeChatTurnDiffFile[]
  added: number
  removed: number
  truncated: boolean
}

/** Recorded edit totals, grouped by the transcript's already-resolved turn boundaries. */
export function nativeChatTurnDiffs(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[]
): Map<string, NativeChatTurnDiff> {
  const turns = new Map<string, Map<string, NativeChatTurnDiffFile>>()
  for (const [index, message] of messages.entries()) {
    const turnKey = turnKeys[index]
    if (!turnKey) {
      continue
    }
    for (const edit of buildDiffSummaries(message.blocks).values()) {
      let files = turns.get(turnKey)
      if (!files) {
        files = new Map()
        turns.set(turnKey, files)
      }
      for (const [fileIndex, file] of edit.files.entries()) {
        const previous = files.get(file.path)
        const renamed =
          file.oldPath && file.oldPath !== file.path ? files.get(file.oldPath) : undefined
        if (renamed) {
          files.delete(renamed.path)
        }
        files.set(file.path, {
          path: file.path,
          added: file.added + (previous?.added ?? 0) + (renamed?.added ?? 0),
          removed: file.removed + (previous?.removed ?? 0) + (renamed?.removed ?? 0),
          truncated:
            file.truncated || (previous?.truncated ?? false) || (renamed?.truncated ?? false),
          target: { messageId: message.id, editKey: edit.key, fileIndex }
        })
      }
    }
  }
  return new Map(
    Array.from(turns, ([key, byPath]) => {
      const files = Array.from(byPath.values())
      return [
        key,
        {
          files,
          added: files.reduce((sum, file) => sum + file.added, 0),
          removed: files.reduce((sum, file) => sum + file.removed, 0),
          truncated: files.some((file) => file.truncated)
        }
      ]
    })
  )
}
