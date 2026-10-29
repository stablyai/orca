import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../native-chat-types'
import { editFilesFromToolPair, isEditToolName } from './native-chat-edit-normalize'
import type { NativeChatEditFile, NativeChatEditLine } from './native-chat-edit-model'
import {
  editFilesFromPatchText,
  type NativeChatEditFileSummary
} from './native-chat-edit-patch-files'
import { pairToolBlocks } from './native-chat-tool-pairs'

/** Shared diff-card copy: desktop translates, mobile renders directly. */
export const NATIVE_CHAT_DIFF_CARD_COPY = {
  diffTruncated: 'Diff truncated',
  diffGap: 'Lines not shown',
  copyDiff: 'Copy diff'
} as const

/** A card's rows as unified patch text, for its copy button. */
export function nativeChatEditFilePatchText(lines: readonly NativeChatEditLine[]): string {
  return lines
    .filter((line) => line.kind !== 'gap')
    .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
    .join('\n')
}

const normalizedEdits = new WeakMap<
  NativeChatBlock,
  {
    result: NativeChatBlock | undefined
    files: NativeChatEditFile[] | null
  }
>()

export function normalizedToolEditFiles(
  call: NativeChatToolCallBlock,
  result: NativeChatToolResultBlock | undefined
): NativeChatEditFile[] | null {
  const cached = normalizedEdits.get(call)
  if (cached && cached.result === result) {
    return cached.files
  }
  const files = editFilesFromToolPair({
    name: call.name,
    input: call.input,
    ...(call.state ? { state: call.state } : {}),
    ...(result
      ? {
          result: {
            output: result.output,
            isError: result.isError,
            editPatch: result.editPatch
          }
        }
      : {})
  })
  normalizedEdits.set(call, { result, files })
  return files
}

export type EditCardModel = {
  editCards: Map<NativeChatBlock, { files: NativeChatEditFile[]; key: string }>
  /** Result blocks the card already speaks for, so they render no second row. */
  consumedResults: Set<NativeChatBlock>
}

/** Fold results into landed-edit cards only. Unconfirmed edits retain generic tool/error rows. */
export function buildEditCards(blocks: NativeChatBlock[]): EditCardModel {
  const editCards: EditCardModel['editCards'] = new Map()
  const consumedResults: EditCardModel['consumedResults'] = new Set()
  for (const [index, pair] of pairToolBlocks(blocks).entries()) {
    const call = pair.call
    if (!call || !isEditToolName(call.name)) {
      continue
    }
    const files = normalizedToolEditFiles(call, pair.result)
    if (!files || files.length === 0) {
      continue
    }
    editCards.set(call, { files, key: `${call.name}:${index}` })
    if (pair.result) {
      consumedResults.add(pair.result)
    }
  }
  return { editCards, consumedResults }
}

const diffSummaries = new WeakMap<
  NativeChatBlock,
  {
    result: NativeChatBlock | undefined
    files: NativeChatEditFileSummary[] | null
  }
>()

// Only the journal's path-only Diff envelope has counts that can be read without tool normalization.
export function buildDiffSummaries(blocks: NativeChatBlock[]): Map<
  NativeChatToolCallBlock,
  {
    files: NativeChatEditFileSummary[]
    key: string
    result: NativeChatToolResultBlock
  }
> {
  const summaries = new Map<
    NativeChatToolCallBlock,
    { files: NativeChatEditFileSummary[]; key: string; result: NativeChatToolResultBlock }
  >()
  for (const [index, pair] of pairToolBlocks(blocks).entries()) {
    const { call, result } = pair
    if (
      !call ||
      call.name !== 'Diff' ||
      call.state === 'running' ||
      call.state === 'failed' ||
      result?.isError ||
      result?.editPatch ||
      !result?.output
    ) {
      continue
    }
    const input = call.input
    if (
      !input ||
      typeof input !== 'object' ||
      !('path' in input) ||
      typeof input.path !== 'string' ||
      Object.keys(input).some((key) => key !== 'path')
    ) {
      continue
    }
    const cached = diffSummaries.get(call)
    let files = cached?.result === result ? cached.files : undefined
    if (files === undefined) {
      files = editFilesFromPatchText(result.output, input.path, true)
      diffSummaries.set(call, { result, files })
    }
    if (files?.length) {
      summaries.set(call, { files, key: `${call.name}:${index}`, result })
    }
  }
  return summaries
}
