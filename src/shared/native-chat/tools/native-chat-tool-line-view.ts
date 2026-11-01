import { agentJournalToolCallLifecycle } from '../../agent-journal-tool-call-lifecycle'
import { isAgentJournalBoundedPayload } from '../../agent-session/journal/agent-session-journal-types'
import {
  isToolCallBlock,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../native-chat-types'
import { diffFromToolCall, type NativeChatDiffLine } from './native-chat-diff'
import { nativeChatPlainCommandInput } from './native-chat-tool-input-text'
import { toolWebSearchResults, type NativeChatWebSearchResult } from './native-chat-tool-identity'
import {
  nativeChatToolLineLabel,
  type NativeChatToolLineLabel
} from './native-chat-tool-line-label'
import { nativeChatToolOutputPartialSizes } from './native-chat-tool-output'
import {
  formatToolInput,
  hasToolInput,
  MAX_TOOL_DETAIL_LENGTH,
  truncateToolDetail
} from './native-chat-tool-summary'

export type NativeChatToolLineView = {
  call: NativeChatToolCallBlock | undefined
  label: NativeChatToolLineLabel | null
  /** What the row opens to: a call's paired result, or a lone result itself. */
  body: NativeChatToolResultBlock | undefined
  /** A lone result's first line, its row's only words. */
  resultPreview: string
  failed: boolean
  /** Link-safe hits only, so unsafe-only results do not open an empty panel. */
  results: NativeChatWebSearchResult[]
  /** The change an edit call proposes; it stands in for the call's arguments. */
  diff: NativeChatDiffLine[] | null
  hasInput: boolean
  hasDetail: boolean
}

export type NativeChatToolLineInput = {
  text: string
  /** Grammar of a lone command; null for structured arguments. */
  language: string | null
  /** Sizes when the host kept only the head of an oversized input. */
  partial: { shown: string; total: string } | null
  /** Held to the inline detail bound until the reader asks for all of it. */
  clipped: boolean
}

const NO_SEARCH_RESULTS: NativeChatWebSearchResult[] = []

export function nativeChatToolLineView(
  block: NativeChatToolCallBlock | NativeChatToolResultBlock,
  result?: NativeChatToolResultBlock
): NativeChatToolLineView {
  const call = isToolCallBlock(block) ? block : undefined
  const label = call ? nativeChatToolLineLabel(call, result) : null
  const body = call ? result : block.type === 'tool-result' ? block : undefined
  // A call the reader stopped was cut short, not failed.
  const lifecycle = call ? agentJournalToolCallLifecycle(call) : null
  const failed = lifecycle === 'failed' || (lifecycle !== 'interrupted' && result?.isError === true)
  const results = call ? toolWebSearchResults(call.webSearchResults) : NO_SEARCH_RESULTS
  // An edit that has not landed has no output yet, but the change it proposes is worth opening.
  const diff = call ? diffFromToolCall(call.name, call.input) : null
  const hasInput =
    call !== undefined &&
    diff === null &&
    hasToolInput(call.input) &&
    nativeChatPlainCommandInput(call.input)?.trim() !== ''
  const hasDetail = body !== undefined || hasInput || results.length > 0 || diff !== null
  const resultPreview = call ? '' : (body?.output.split('\n')[0]?.slice(0, 80) ?? '')
  return { call, label, body, resultPreview, failed, results, diff, hasInput, hasDetail }
}

/** An opened call's invocation: a lone command as typed, else every argument it was given. */
export function nativeChatToolLineInput(
  call: NativeChatToolCallBlock,
  /** The row's `commandLanguage`, so a lone command keeps its colors. */
  commandLanguage: string | null,
  expanded: boolean
): NativeChatToolLineInput {
  // The host swaps an oversized input for its JSON head; formatting reads that head.
  const bounded =
    isAgentJournalBoundedPayload(call.input) && call.input.truncated ? call.input : null
  const command = bounded ? null : nativeChatPlainCommandInput(call.input)
  const full = command ?? formatToolInput(call.input)
  const clipped = !expanded && full.length > MAX_TOOL_DETAIL_LENGTH
  return {
    text: clipped ? truncateToolDetail(full) : full,
    language: command === null ? null : commandLanguage,
    partial: bounded ? nativeChatToolOutputPartialSizes(bounded) : null,
    clipped
  }
}
