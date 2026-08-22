/**
 * IBM Bob Shell output-status profile. Bob emits no hooks and no OSC title, so
 * its working / waiting / done rows come from the rendered composer, spinner
 * and approval prompt (captured from Bob Shell 2.0.1).
 */
import {
  createAgentOutputStatusDetector,
  type AgentOutputStatusDetector,
  type AgentOutputStatusDetectorArgs,
  type AgentOutputStatusProfile
} from './agent-output-status-detector'
import { cleanCommandCodePromptCandidate } from './command-code-prompt-text'
import { stripTerminalControl } from './terminal-control-stripping'

const BOB_SPINNER_RE_SOURCE = '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]'
const BOB_COMPOSER_PLACEHOLDER = 'Build Anything, @ for context'
// Why: the composer placeholder and the steer hint are Bob-only strings; either
// proves the chat UI is on screen, unlike the generic "Agent Mode" status bar.
const BOB_BANNER_RE = new RegExp(
  `(?:^|[\\r\\n])\\s*(?:❯\\s+${BOB_COMPOSER_PLACEHOLDER}|${BOB_SPINNER_RE_SOURCE}?\\s*Processing(?:…|\\.\\.\\.) \\(Enter to steer)`
)
const BOB_ACTIVE_STATUS_RE = new RegExp(
  `(?:^|[\\r\\n])\\s*(?:${BOB_SPINNER_RE_SOURCE}\\s*)?Processing(?:…|\\.\\.\\.)`
)
const BOB_IDLE_PROMPT_RE = new RegExp(`(?:^|[\\r\\n])\\s*❯\\s+${BOB_COMPOSER_PLACEHOLDER}`)
// Why: tool approvals render a "→ Approve Once / Always Allow … / Reject" menu;
// skill approvals lead with their own sentence before the same menu.
const BOB_WAITING_RES = [
  /(?:^|[\r\n])\s*→?\s*Approve Once\b/,
  /(?:^|[\r\n])\s*Approve commands:/,
  /Allow Bob to use this skill/
] as const

function isBobLaunchCommand(command: string | null | undefined): boolean {
  if (!command) {
    return false
  }
  // Why: `bob chat` / bare `bob` open the TUI; `bob use …` is the Neovim manager.
  return /(?:^|[\s;&|])bob(?:\.(?:js|cmd))?(?:\s+chat\b|\s+-|\s*$)/.test(command)
}

function rawTextMayContainBobBanner(rawText: string): boolean {
  return rawText.includes('B') || rawText.includes('P')
}

function isBobIdlePromptCandidate(value: string): boolean {
  return value.replace(/\s+/g, '').startsWith(BOB_COMPOSER_PLACEHOLDER.replace(/\s+/g, ''))
}

export const BOB_OUTPUT_STATUS_PROFILE: AgentOutputStatusProfile = {
  agent: 'bob',
  isLaunchCommand: isBobLaunchCommand,
  rawTextMayContainBanner: rawTextMayContainBobBanner,
  bannerRe: BOB_BANNER_RE,
  activeStatusRes: [BOB_ACTIVE_STATUS_RE],
  idlePromptRe: BOB_IDLE_PROMPT_RE,
  waitingRes: BOB_WAITING_RES,
  promptEchoRe: /(?:^|[\r\n])\s*❯\s+([^\r\n]+)(?=[\r\n])/g,
  cleanPromptCandidate: (value) => cleanCommandCodePromptCandidate(stripTerminalControl(value)),
  isIdlePromptCandidate: isBobIdlePromptCandidate,
  feedsPromptLifecycle: true
}

export function createBobOutputStatusDetector(
  args: AgentOutputStatusDetectorArgs
): AgentOutputStatusDetector {
  return createAgentOutputStatusDetector(BOB_OUTPUT_STATUS_PROFILE, args)
}
