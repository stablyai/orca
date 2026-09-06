// Projects OMP's three tool-execution frames onto the overlay's block list.
//
// Split from the reducer because tool blocks are the one part of the overlay
// with an identity relation rather than a pure append: `tool_execution_update`
// streams the output produced so far for a call that `tool_execution_end` then
// finalizes, so both must land on the SAME `tool-result` row. Appending each
// frame instead would render a running bash tool as one row per chunk and then
// a duplicate final row — and the overlay's transcript dedupe (F8) keys on
// `toolCallId`, so those extra rows would survive the transcript catching up.

import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import type { OmpRpcToolExecutionStartFrame } from '../../../../shared/omp-rpc-protocol'
import {
  capOverlayBlocks,
  capOverlayText,
  TOOL_OUTPUT_MAX_BYTES
} from './omp-rpc-overlay-retention'

export function appendOmpRpcToolCallBlock(
  blocks: readonly NativeChatBlock[],
  frame: OmpRpcToolExecutionStartFrame
): NativeChatBlock[] {
  return capOverlayBlocks([
    ...blocks,
    {
      type: 'tool-call',
      name: frame.toolName ?? 'tool',
      input: frame.args,
      ...(frame.toolCallId ? { toolCallId: frame.toolCallId } : {})
    }
  ])
}

/** Writes the latest known output for one call. Replaces the call's existing
 *  result row when it has one; an id-less frame can be paired with nothing, so
 *  it always appends rather than overwriting an unrelated call's row. */
export function upsertOmpRpcToolResultBlock(
  blocks: readonly NativeChatBlock[],
  result: { toolCallId?: string; output: string; isError: boolean }
): NativeChatBlock[] {
  const block: NativeChatBlock = {
    type: 'tool-result',
    output: capOverlayText(result.output, TOOL_OUTPUT_MAX_BYTES),
    isError: result.isError,
    ...(result.toolCallId ? { toolCallId: result.toolCallId } : {})
  }
  const existing = result.toolCallId
    ? blocks.findIndex(
        (candidate) =>
          candidate.type === 'tool-result' && candidate.toolCallId === result.toolCallId
      )
    : -1
  return existing === -1
    ? capOverlayBlocks([...blocks, block])
    : blocks.map((candidate, index) => (index === existing ? block : candidate))
}
