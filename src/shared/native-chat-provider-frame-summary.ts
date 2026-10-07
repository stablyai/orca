import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

type ProviderFrameTextBlock = Extract<NativeChatBlock, { type: 'text' }>

export function nativeChatProviderFrameSummary(block: ProviderFrameTextBlock): string {
  const frame = block.providerFrame
  if (!frame) {
    return block.text
  }
  return block.text === `${frame.provider} · ${frame.kind}` ? frame.kind : block.text
}

/** Claude's answer to a local slash command (`/usage`); its words ride the payload's `content`. */
export const CLAUDE_LOCAL_COMMAND_OUTPUT_FRAME_KIND = 'message:system:local_command_output'

/** Codex's plan update: wordless, but the task list is read from it. */
export const CODEX_PLAN_UPDATED_FRAME_KIND = 'notification:turn/plan/updated'

/** The fields the wordless check reads: a journal status row, or the text block it projects to. */
export type ProviderFrameRowText = {
  text: string
  tone?: string
  presentation?: string
  failure?: unknown
  providerFrame?: { provider: string; kind: string }
}

/**
 * An unrecognised provider event stored with no words of its own: the host's fallback label is
 * its only text. Kept in the journal for readers of the frame (the Codex task list), never drawn.
 * A failure or notice (any tone) and a request Orca already answered stay visible. The host's
 * per-turn row cap reads this same rule, so a row no client draws never fills it.
 */
export function isWordlessProviderFrame(row: ProviderFrameRowText): boolean {
  const frame = row.providerFrame
  return (
    frame !== undefined &&
    row.tone === undefined &&
    row.presentation === undefined &&
    row.failure === undefined &&
    !frame.kind.startsWith('request:') &&
    // Older hosts stored a local command's output only in the payload; the row keeps it there.
    !(frame.provider === 'claude' && frame.kind === CLAUDE_LOCAL_COMMAND_OUTPUT_FRAME_KIND) &&
    row.text === `${frame.provider} · ${frame.kind}`
  )
}

export function isWordlessProviderFrameBlock(block: NativeChatBlock): boolean {
  return block.type === 'text' && isWordlessProviderFrame(block)
}

/** A row made only of wordless provider events: it draws nothing. */
export function isWordlessProviderFrameMessage(message: NativeChatMessage): boolean {
  return message.blocks.length > 0 && message.blocks.every(isWordlessProviderFrameBlock)
}
