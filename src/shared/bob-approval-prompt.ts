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

// Why: a modal line (or the banner) can straddle several PTY writes, so each write is judged
// with a rolling tail of what came before it.
const CARRY_OVER_LIMIT = 512

export type BobApprovalPromptDetector = {
  /** True only on the write that first paints a modal, so a repainting TUI fires once. */
  observe: (data: string) => boolean
  /** Call on any input written to the pane. */
  observeInput: () => void
}

export function textShowsBobApprovalPrompt(text: string): boolean {
  return BOB_APPROVAL_RES.some((pattern) => pattern.test(text))
}

const BOB_APPROVAL_GLOBAL_RES = BOB_APPROVAL_RES.map((pattern) => new RegExp(pattern.source, 'g'))
const BOB_BANNER_GLOBAL_RES = [new RegExp(BOB_BANNER_RE.source, 'g')]

function countMatches(text: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((count, pattern) => count + [...text.matchAll(pattern)].length, 0)
}

// Why counts: the carried tail was judged on the previous write, but it can still hold an old
// match while a new one completes across the boundary; only a match reaching into this write is new.
function hasNewMatch(previous: string, text: string, patterns: readonly RegExp[]): boolean {
  return countMatches(text, patterns) > countMatches(stripTerminalControl(previous), patterns)
}

// Why: `bob` alone only opens the TUI on a real TTY; `bob chat` is Orca's launch command and the
// only form worth fast-arming on. `bob use …`/`bob install …` are the Neovim version manager.
function isBobLaunchCommand(command: string | null | undefined): boolean {
  if (!command) {
    return false
  }
  return /(?:^|[\s;&|])bob(?:\.(?:js|cmd))?(?:\s+chat\b|\s*$)/.test(command)
}

/**
 * Edge-triggered: fires when a modal first appears and stays armed until the user has typed and the
 * composer is then painted with no modal beside it. Neither alone proves the modal closed — the
 * transcripts show the spawn modal painted once while the composer below it keeps repainting (a
 * resize would repaint the still-open modal), and ↑↓ input repaints the modal without closing it.
 *
 * Self-arms on Bob's own launch command or composer banner first (never on the approval text
 * alone), so an unrelated CLI that happens to print "Approve Once" cannot misattribute its status
 * to Bob.
 */
export function createBobApprovalPromptDetector(args: {
  startupCommand?: string | null
}): BobApprovalPromptDetector {
  let hasSeenBobUi = isBobLaunchCommand(args.startupCommand)
  let carryOver = ''
  let armed = false
  // Why: only input can close a modal; a modal repaint after that input shows it is still open.
  let inputSinceModal = false

  return {
    observeInput(): void {
      inputSinceModal = armed
    },
    observe(data: string): boolean {
      if (data.length === 0) {
        return false
      }
      const previous = carryOver
      const frame = `${previous}${data}`
      carryOver = frame.slice(-CARRY_OVER_LIMIT)
      // Why the cheap prefilters before stripping: every PTY write on a Bob pane reaches here.
      const mayShowModal = frame.includes('Approve')
      const mayShowComposer = frame.includes('Anything')
      if (!mayShowModal && !mayShowComposer) {
        return false
      }
      const text = stripTerminalControl(frame)
      const showsComposer = mayShowComposer && BOB_BANNER_RE.test(text)
      hasSeenBobUi ||= showsComposer
      if (!hasSeenBobUi) {
        return false
      }
      if (mayShowModal && hasNewMatch(previous, text, BOB_APPROVAL_GLOBAL_RES)) {
        inputSinceModal = false
        if (armed) {
          return false
        }
        armed = true
        return true
      }
      if (inputSinceModal && showsComposer && hasNewMatch(previous, text, BOB_BANNER_GLOBAL_RES)) {
        armed = false
        inputSinceModal = false
      }
      return false
    }
  }
}
