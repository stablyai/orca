import { agentJournalToolCallLifecycle } from '../../agent-journal-tool-call-lifecycle'
import {
  isToolCallBlock,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../../native-chat-types'
import { diffFromToolCall } from './native-chat-diff'
import { toolWebSearchResults, type NativeChatWebSearchResult } from './native-chat-tool-identity'
import {
  nativeChatToolLineLabel,
  type NativeChatToolLineLabel
} from './native-chat-tool-line-label'

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
  hasDetail: boolean
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
  const hasDetail =
    body !== undefined ||
    label?.commandDetail != null ||
    results.length > 0 ||
    (call !== undefined && diffFromToolCall(call.name, call.input) !== null)
  const resultPreview = call ? '' : (body?.output.split('\n')[0]?.slice(0, 80) ?? '')
  return { call, label, body, resultPreview, failed, results, hasDetail }
}
