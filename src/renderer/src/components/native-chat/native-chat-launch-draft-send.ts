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

/** Only an observably empty prompt confirms clearing; placeholders, edits and unreadable screens do not. */
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

/** Visual wrapping loses logical lines, so replace from the composer copy rather than trusting a screen match. */
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

/** Select replacement clearing and optional confirmation for the normal send paths. */
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
  // A resolved prefill no longer owns TUI input; clearing again could erase the user’s replacement.
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
