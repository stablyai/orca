import type { NativeChatEditFile } from '../../../../shared/native-chat/tools/native-chat-edit-model'
import type {
  NativeChatMessage,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import {
  buildDiffSummaries,
  normalizedToolEditFiles
} from '../../../../shared/native-chat/tools/native-chat-edit-cards'

export type NativeChatDiffTarget = {
  messageId: string
  editKey: string
  fileIndex: number
  /** The subagent sections the row sits in, outermost first, which a reveal opens. */
  subagentSections?: readonly string[]
}

export type NativeChatDiffReveal = NativeChatDiffTarget & { requestId: number }

export type NativeChatTurnDiffEdit = {
  call: NativeChatToolCallBlock
  result: NativeChatToolResultBlock
  fileIndex: number
  target: NativeChatDiffTarget
  order: number
}

export type NativeChatTurnDiffFile = {
  path: string
  added: number
  removed: number
  truncated: boolean
  target: NativeChatDiffTarget
  edits: NativeChatTurnDiffEdit[]
}

export type NativeChatTurnDiff = {
  files: NativeChatTurnDiffFile[]
  added: number
  removed: number
  truncated: boolean
}

/** Resolve a patch only when its inline card is opened. */
export function nativeChatTurnDiffEditFile(
  edit: NativeChatTurnDiffEdit
): NativeChatEditFile | undefined {
  return normalizedToolEditFiles(edit.call, edit.result)?.[edit.fileIndex]
}

/** Recorded edit totals, grouped by the transcript's already-resolved turn boundaries. */
export function nativeChatTurnDiffs(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  subagentSectionsOf?: ReadonlyMap<string, readonly string[]>,
  /** A turn only partly loaded, whose totals would read as the whole turn's. */
  partialTurnKey?: string
): Map<string, NativeChatTurnDiff> {
  const turns = new Map<string, Map<string, NativeChatTurnDiffFile>>()
  let editOrder = 0
  for (const [index, message] of messages.entries()) {
    const turnKey = turnKeys[index]
    if (!turnKey || turnKey === partialTurnKey) {
      continue
    }
    const sections = subagentSectionsOf?.get(message.id)
    for (const [call, edit] of buildDiffSummaries(message.blocks)) {
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
        const target: NativeChatDiffTarget = {
          messageId: message.id,
          editKey: edit.key,
          fileIndex,
          ...(sections === undefined ? {} : { subagentSections: sections })
        }
        const entry = previous ??
          renamed ?? {
            path: file.path,
            added: 0,
            removed: 0,
            truncated: false,
            target,
            edits: []
          }
        if (renamed && previous) {
          entry.added += renamed.added
          entry.removed += renamed.removed
          entry.truncated ||= renamed.truncated
          entry.edits.push(...renamed.edits)
          entry.edits.sort((left, right) => left.order - right.order)
        }
        entry.path = file.path
        entry.added += file.added
        entry.removed += file.removed
        entry.truncated ||= file.truncated
        entry.target = target
        entry.edits.push({ call, result: edit.result, fileIndex, target, order: editOrder++ })
        files.set(file.path, entry)
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
