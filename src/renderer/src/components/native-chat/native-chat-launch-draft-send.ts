// Choosing how a chat send lands when the agent's TUI input line still holds a
// launch-context draft that Orca itself injected.

import { buildAgentTuiClearInputForText } from '../../../../shared/agent-tui-input-clear'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

export type NativeChatLaunchDraftSendPlan =
  /** Input line holds a stale injected draft — replace it, clearing every line. */
  | { kind: 'replace-draft'; clearInput: string; seededText: string }
  /** No injected draft is parked on the line; keep the ordinary send path. */
  | { kind: 'default' }

/** Prompt glyphs both supported agent TUIs draw at the start of the input line. */
const COMPOSER_PROMPT_LINE = /^\s*([❯›])\s?(.*)$/
const CLAUDE_FRAME_LINE = /^\s*─{3,}\s*$/
const CODEX_FOOTER_LINE = /^\s*\S.*\s[·•]\s.*$/

function composerContinuationIsEmpty(lines: string[], promptIndex: number, glyph: string): boolean {
  for (let index = promptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (
      (glyph === '❯' && CLAUDE_FRAME_LINE.test(line)) ||
      (glyph === '›' && CODEX_FOOTER_LINE.test(line))
    ) {
      return true
    }
    if (line.trim() !== '') {
      return false
    }
  }
  return true
}

/**
 * Whether the rendered composer prompt is observably empty. Placeholder text,
 * unrelated edits, and unreadable screens are all unconfirmed.
 */
export function agentInputLineCleared(screen: string | null | undefined): boolean {
  if (!screen) {
    return false
  }
  const lines = stripScrollbackAnsi(screen).split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = COMPOSER_PROMPT_LINE.exec(lines[index]!)
    if (match) {
      return match[2]!.trim() === '' && composerContinuationIsEmpty(lines, index, match[1]!)
    }
  }
  return false
}

/**
 * A serialized screen cannot prove the whole parked draft still matches: visual
 * wrapping loses logical-line boundaries. Always replace from the composer copy.
 */
export function planNativeChatLaunchDraftSend(args: {
  /** Text Orca injected into the TUI line, or null when nothing is parked there. */
  seededText: string | null | undefined
}): NativeChatLaunchDraftSendPlan {
  const seededText = args.seededText
  if (!seededText || seededText.trim() === '') {
    return { kind: 'default' }
  }
  return {
    kind: 'replace-draft',
    clearInput: buildAgentTuiClearInputForText(seededText),
    seededText
  }
}

/** What a composer send needs: which path to take, and the clear/confirm bytes
 *  the ordinary send paths should use when it is a draft replacement. */
export function resolveNativeChatLaunchDraftSend(args: {
  launchDraft: { agent: string; text: string } | null | undefined
  launchDraftResolved: boolean
  agent: string
  readScreen: () => string | null | undefined
}): {
  plan: NativeChatLaunchDraftSendPlan
  sendOptions: { clearInput: string; confirmCleared: () => boolean } | undefined
} {
  const { launchDraft, launchDraftResolved, agent, readScreen } = args
  // A resolved draft was already submitted or cleared TUI-side, so nothing of
  // ours is on the line any more — treating it as parked would clear or submit
  // a buffer that no longer holds it.
  const seededText =
    launchDraft && launchDraft.agent === agent && !launchDraftResolved ? launchDraft.text : null
  const plan = planNativeChatLaunchDraftSend({ seededText })
  if (plan.kind !== 'replace-draft') {
    return { plan, sendOptions: undefined }
  }
  return {
    plan,
    sendOptions: {
      clearInput: plan.clearInput,
      confirmCleared: () => agentInputLineCleared(readScreen())
    }
  }
}
