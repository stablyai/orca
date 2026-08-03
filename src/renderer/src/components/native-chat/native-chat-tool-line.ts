import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock
} from '../../../../shared/native-chat-types'
import { diffFromText, diffFromToolCall, type DiffLine } from './native-chat-diff'
import { formatToolInput, summarizeToolInput } from './native-chat-tool-summary'

// Pure derivation for one tool line, split out of the component so the
// expensive parts run once per block instead of on every parent render.
// formatToolInput is JSON.stringify over an unbounded tool input, and during
// streaming the parent re-renders every frame.

export const MAX_TOOL_RESULT_CHARS = 4000

export type ToolLineModel = {
  name: string
  preview: string
  diff: DiffLine[] | null
  body: { output: string; isError?: boolean } | null
  /** Formatted input for a diff-less call, already truncated for display. */
  detail: string | null
  /** Whether expanding shows anything the inline preview does not already. */
  hasDetail: boolean
}

function truncateForDisplay(value: string): string {
  return value.length > MAX_TOOL_RESULT_CHARS ? `${value.slice(0, MAX_TOOL_RESULT_CHARS)}…` : value
}

export function deriveToolLine(block: NativeChatBlock): ToolLineModel | null {
  if (isToolCallBlock(block)) {
    const preview = summarizeToolInput(block.input)
    const diff = diffFromToolCall(block.name, block.input)
    const detail = diff ? null : formatToolInput(block.input)
    // Compared before truncation so a long input that merely repeats the preview
    // still reads as "nothing more to show".
    const detailAddsInfo = detail !== null && detail.replace(/\s+/g, ' ').trim() !== preview
    return {
      name: block.name,
      preview,
      diff,
      body: null,
      detail: detail === null ? null : truncateForDisplay(detail),
      hasDetail: diff !== null || detailAddsInfo
    }
  }

  if (isToolResultBlock(block)) {
    return {
      name: translate('components.native-chat.tool.result', 'Result'),
      preview: block.output.split('\n')[0]?.slice(0, 80) ?? '',
      diff: diffFromText(block.output),
      body: { output: truncateForDisplay(block.output), isError: block.isError },
      detail: null,
      hasDetail: true
    }
  }

  return null
}
