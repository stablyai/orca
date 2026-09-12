import { stripTerminalControl } from './terminal-control-stripping'

/**
 * Detects IBM Bob's approval modals in rendered PTY output.
 *
 * Why a screen rule at all: Bob 2.0.2 has no hook for a pending approval. `PreToolUse` fires
 * *before* the modal and then Bob emits nothing until the user answers, so a hook-only pane sits
 * on `working` while it is actually blocked — no attention row, no bell, no notification.
 *
 * Written against committed transcripts (`src/main/runtime/__fixtures__/bob-approval-*.txt`,
 * Bob 2.0.2, 120x40), which show two different modals:
 *
 *   Execute Command            |   Subagent (general)
 *   Command:          ls -la   |   → Approve Once
 *   Approve commands:          |     Approve subagent tools for task
 *   → Approve Once             |     Reject
 *     Always Allow Command for task
 *     Reject
 *
 * `→ Approve Once` is the only line both shapes share, so it is the primary signal; the
 * shape-specific lines are kept so a future Bob that relabels the menu item still matches one.
 */
const BOB_APPROVAL_RES = [
  /(?:^|[\r\n])[^\S\r\n]*→[^\S\r\n]*Approve Once\b/,
  /(?:^|[\r\n])[^\S\r\n]*Approve commands:/,
  /(?:^|[\r\n])[^\S\r\n]*Approve subagent tools for task\b/
] as const

// Why: the composer placeholder is Bob-only chrome (captured on 2.0.2), so seeing it once proves
// the pane is really running Bob before the approval regexes — which say nothing about identity
// on their own — are allowed to fire. Mirrors command-code's own banner self-arm.
const BOB_COMPOSER_PLACEHOLDER = 'Build Anything, @ for context'
const BOB_BANNER_RE = new RegExp(
  `(?:^|[\\r\\n])[^\\S\\r\\n]*❯[^\\S\\r\\n]*${BOB_COMPOSER_PLACEHOLDER}`
)

// Why: a modal (or the banner) can straddle two PTY writes, so each frame is judged with a short
// carry-over of the previous one. It is deliberately small — a window long enough to still hold
// the *previous* modal would keep the detector armed across a repaint that no longer shows one,
// and every approval after the first would then be swallowed.
const CARRY_OVER_LIMIT = 512

export type BobApprovalPromptDetector = {
  /** True only on the chunk that first paints a modal, so a repainting TUI fires once. */
  observe: (data: string) => boolean
}

export function textShowsBobApprovalPrompt(text: string): boolean {
  return BOB_APPROVAL_RES.some((pattern) => pattern.test(text))
}

// Why: `bob` alone only opens the TUI on a real TTY; `bob chat` is Orca's launch command and the
// only form worth fast-arming on. `bob use …`/`bob install …` are the Neovim version manager.
function isBobLaunchCommand(command: string | null | undefined): boolean {
  if (!command) {
    return false
  }
  return /(?:^|[\s;&|])bob(?:\.(?:js|cmd))?(?:\s+chat\b|\s*$)/.test(command)
}

function rawTextMayContainBobBanner(rawText: string): boolean {
  // Why: the banner needs this exact placeholder; it is rare enough in other output that most
  // chunks skip the strip+regex path below.
  return rawText.includes('Anything')
}

/**
 * Edge-triggered: Bob repaints the whole modal region every frame, so the detector fires on the
 * rising edge and disarms as soon as a frame no longer carries it. That makes the next approval
 * in the same session fire again without any timer.
 *
 * Self-arms on Bob's own launch command or composer banner first (never on the approval text
 * alone), so an unrelated CLI that happens to print "Approve Once" cannot misattribute its status
 * to Bob.
 */
export function createBobApprovalPromptDetector(
  args: { startupCommand?: string | null },
  onApprovalPrompt: () => void
): BobApprovalPromptDetector {
  let hasSeenBobUi = isBobLaunchCommand(args.startupCommand)
  let carryOver = ''
  let armed = false

  return {
    observe(data: string): boolean {
      if (data.length === 0) {
        return false
      }
      const frame = `${carryOver}${data}`

      if (!hasSeenBobUi) {
        if (!rawTextMayContainBobBanner(frame)) {
          carryOver = data.slice(-CARRY_OVER_LIMIT)
          return false
        }
        if (!BOB_BANNER_RE.test(stripTerminalControl(frame))) {
          carryOver = data.slice(-CARRY_OVER_LIMIT)
          return false
        }
        hasSeenBobUi = true
      }

      // Why the cheap prefilter before stripping: every PTY chunk on an armed Bob pane still
      // reaches here on every frame, and only the approval menu carries this word.
      if (!frame.includes('Approve')) {
        carryOver = data.slice(-CARRY_OVER_LIMIT)
        armed = false
        return false
      }
      if (!textShowsBobApprovalPrompt(stripTerminalControl(frame))) {
        carryOver = data.slice(-CARRY_OVER_LIMIT)
        armed = false
        return false
      }
      // Why drop the carry-over on a match: it already holds a full modal, so keeping it would
      // re-satisfy the match on the next repaint and hold `armed` past the frame that clears it.
      carryOver = ''
      if (armed) {
        return false
      }
      armed = true
      onApprovalPrompt()
      return true
    }
  }
}
