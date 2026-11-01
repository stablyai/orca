import { agentJournalToolCallLifecycle } from '../../agent-journal-tool-call-lifecycle'
import {
  isToolCallBlock,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../native-chat-types'
import { diffFromToolCall } from './native-chat-diff'
import { nativeChatPlainCommandInput } from './native-chat-tool-input-text'
import { toolWebSearchResults, type NativeChatWebSearchResult } from './native-chat-tool-identity'
import {
  nativeChatToolLineLabel,
  type NativeChatToolLineLabel
} from './native-chat-tool-line-label'
import { formatToolInput, hasToolInput } from './native-chat-tool-summary'

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
  /** The call's arguments open with it; an edit's diff already shows them. */
  hasInput: boolean
  hasDetail: boolean
}

export type NativeChatToolLineInput = {
  /** The tool's own name, which a row's verb or MCP label stands in for. */
  name: string
  text: string
  /** Grammar of a lone command; null for structured arguments. */
  language: string | null
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
  const diff = call !== undefined && diffFromToolCall(call.name, call.input) !== null
  const hasInput = call !== undefined && !diff && hasToolInput(call.input)
  const hasDetail = body !== undefined || hasInput || results.length > 0 || diff
  const resultPreview = call ? '' : (body?.output.split('\n')[0]?.slice(0, 80) ?? '')
  return { call, label, body, resultPreview, failed, results, hasInput, hasDetail }
}

/** An opened call's invocation: a lone command as typed, else every argument it was given. */
export function nativeChatToolLineInput(
  call: NativeChatToolCallBlock,
  label: NativeChatToolLineLabel | null
): NativeChatToolLineInput {
  const command = nativeChatPlainCommandInput(call.input)
  return {
    name: call.name,
    text: command ?? formatToolInput(call.input),
    language: command === null ? null : (label?.commandLanguage ?? null)
  }
}
