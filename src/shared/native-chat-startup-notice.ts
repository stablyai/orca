// Presentation model for a TUI agent's blocking startup dialog (self-update prompt,
// trust/workspace dialog, hooks-review, cwd picker, approval menu) plus the Codex
// self-update's own two extra phases (running, restart-required) surfaced in the native
// chat view. The chat view has no other way to see these: they happen before any
// conversation turn, so neither the transcript nor agent-hook status carries them — see
// src/main/native-chat/transcript-line-decoders-codex.ts, which silently drops anything
// that isn't a conversation turn.
//
// Pure: reads an already-serialized terminal viewport (ANSI included — xterm's
// SerializeAddon preserves SGR styling by default) and turns it into structured,
// presentable content. No React, no PTY access, no polling — that state lives in the
// renderer hook (use-native-chat-startup-notice.ts) which also owns the two phases that
// cannot be read from a single snapshot: 'update-failed' (needs "was running, agent is now
// gone") and 'restarting' (an intent the hook itself set).

import { stripScrollbackAnsi } from './terminal-ansi-strip'
import {
  findActionableTerminalWaitBlockedSignal,
  isKnownReadyPromptPreview
} from './agent-startup-prompt-detection'
import type { RuntimeTerminalWaitBlockedReason } from './runtime-types'

export type NativeChatStartupPhase =
  | 'prompt'
  | 'running'
  | 'restart-required'
  | 'update-failed'
  | 'restarting'

export type NativeChatStartupNoticeOption = {
  label: string
  /** Literal bytes to write to the agent's PTY, e.g. a menu digit or `\r`. */
  send: string
}

export type NativeChatStartupNotice = {
  phase: NativeChatStartupPhase
  /** Set only for `phase: 'prompt'`; null for every other phase. */
  reason: RuntimeTerminalWaitBlockedReason | null
  title: string
  /** ANSI-stripped tail of the terminal, most-recent line last. */
  body: string[]
  /** Empty for every phase but `'prompt'` — the other phases are answered through
   *  phase-specific UI (restart button, dismiss), not a raw PTY send. */
  options: NativeChatStartupNoticeOption[]
}

const REASON_TITLES: Record<RuntimeTerminalWaitBlockedReason, string> = {
  'codex-update-prompt': 'Codex has an update',
  'codex-trust-workspace': 'Codex wants to trust this workspace',
  'codex-cwd-prompt': 'Codex is asking about the working directory',
  'codex-model-migration-prompt': 'Codex has a new default model',
  'codex-hooks-review-prompt': 'Codex hooks need review',
  'codex-interactive-prompt': 'Codex needs your input',
  'agent-approval-prompt': 'Codex wants to run a command'
}

const PHASE_TITLES: Record<Exclude<NativeChatStartupPhase, 'prompt'>, string> = {
  running: 'Updating Codex…',
  'restart-required': 'Update complete — restart required',
  'update-failed': 'Codex update did not finish',
  restarting: 'Restarting Codex…'
}

// Real capture, verbatim, from the Codex self-update flow reported over a Windows PTY:
// "Updating Codex via `npm install -g @openai/codex`..." → npm output → "🎉 Update ran
// successfully! Please restart Codex." Matched case-insensitively; ANSI already stripped.
const UPDATE_RUNNING_MARKERS = ['updating codex via', 'npm install -g @openai/codex']
const UPDATE_RESTART_REQUIRED_MARKERS = ['update ran successfully', 'please restart codex']

const MAX_ACTIVITY_TAIL_LINES = 14

/** ANSI-stripped tail of the viewport, most-recent line last, blank lines dropped. */
export function readTerminalActivityTail(
  screenText: string,
  maxLines: number = MAX_ACTIVITY_TAIL_LINES
): string[] {
  const lines = stripScrollbackAnsi(screenText)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.slice(-maxLines)
}

/** Wraps `isKnownReadyPromptPreview`: true once the agent has reached its own ready prompt,
 *  the signal the polling hook uses to stop watching for good. */
export function isAgentStartupSettled(screenText: string): boolean {
  return isKnownReadyPromptPreview(stripScrollbackAnsi(screenText))
}

function containsAllMarkers(normalized: string, markers: readonly string[]): boolean {
  return markers.every((marker) => normalized.includes(marker))
}

const NUMBERED_OPTION_RE = /^[>❯]?\s*(\d)[.)]\s+(.{1,60})$/

/** Parse a numbered menu ("1. Update now") into raw digit sends; falls back to a single
 *  Continue/Trust option when the dialog is a bare "press enter/t" prompt with no menu. */
function parseStartupNoticeOptions(body: readonly string[]): NativeChatStartupNoticeOption[] {
  const numbered: NativeChatStartupNoticeOption[] = []
  for (const line of body) {
    const match = NUMBERED_OPTION_RE.exec(line)
    if (match) {
      numbered.push({ label: match[2].trim(), send: match[1] })
    }
  }
  if (numbered.length > 0) {
    return numbered
  }
  const normalized = body.join('\n').toLowerCase()
  if (normalized.includes('press t to trust')) {
    return [{ label: 'Trust', send: 't' }]
  }
  if (
    normalized.includes('press enter to continue') ||
    normalized.includes('press enter to confirm') ||
    normalized.includes('press enter to view') ||
    normalized.includes('press enter to insert')
  ) {
    return [{ label: 'Continue', send: '\r' }]
  }
  return []
}

/**
 * Read the current startup notice from a live terminal viewport, or null when none of the
 * three text-detectable phases apply. Priority — restart-required, then running, then a
 * blocked prompt reason — because a dismissed/scrolled banner from an earlier phase can
 * still be present in the same viewport as the current one; the most-advanced phase wins.
 *
 * Does not detect `'update-failed'` or `'restarting'`: those require state this module does
 * not have (a prior 'running' observation, an explicit restart intent) and are composed by
 * the renderer hook on top of this reader.
 */
export function readNativeChatStartupNotice(screenText: string): NativeChatStartupNotice | null {
  const stripped = stripScrollbackAnsi(screenText)
  const normalized = stripped.toLowerCase()
  const body = readTerminalActivityTail(screenText)

  if (containsAllMarkers(normalized, UPDATE_RESTART_REQUIRED_MARKERS)) {
    return {
      phase: 'restart-required',
      reason: null,
      title: PHASE_TITLES['restart-required'],
      body,
      options: []
    }
  }
  if (containsAllMarkers(normalized, UPDATE_RUNNING_MARKERS)) {
    return { phase: 'running', reason: null, title: PHASE_TITLES.running, body, options: [] }
  }
  const signal = findActionableTerminalWaitBlockedSignal(normalized)
  if (signal) {
    return {
      phase: 'prompt',
      reason: signal.reason,
      title: REASON_TITLES[signal.reason],
      body,
      options: parseStartupNoticeOptions(body)
    }
  }
  return null
}

/** Builds the `'update-failed'` / `'restarting'` notices the hook composes from state this
 *  module cannot read on its own. Exposed so the hook and its tests share one source of
 *  title copy instead of inlining `PHASE_TITLES` lookups themselves. */
export function buildNativeChatStartupPhaseNotice(
  phase: 'update-failed' | 'restarting',
  screenText: string
): NativeChatStartupNotice {
  return {
    phase,
    reason: null,
    title: PHASE_TITLES[phase],
    body: readTerminalActivityTail(screenText),
    options: []
  }
}

/** Same as `buildNativeChatStartupPhaseNotice`, but takes an already-computed body instead
 *  of re-deriving it from a screenshot — for the `restarting` transition, which fires from
 *  the last observed `restart-required` notice rather than a fresh terminal read (the PTY
 *  is mid-respawn and has nothing new to show yet). */
export function nativeChatStartupPhaseNoticeWithBody(
  phase: Exclude<NativeChatStartupPhase, 'prompt'>,
  body: readonly string[]
): NativeChatStartupNotice {
  return { phase, reason: null, title: PHASE_TITLES[phase], body: [...body], options: [] }
}
