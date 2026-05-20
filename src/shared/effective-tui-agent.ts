// Why: built-ins and custom agent presets (issue #2284) live in different shapes —
// built-ins in TUI_AGENT_CONFIG keyed by TuiAgent, customs in GlobalSettings.customTuiAgents.
// This module merges them into a single EffectiveTuiAgent view so launch, detection, and
// picker code paths can iterate one list. Keeps `TuiAgent` strongly typed for code paths
// that must remain built-in-only (process recognition, trust preflight, commit-message AI).

import type {
  AgentPromptInjectionMode,
  CustomTuiAgent,
  CustomTuiAgentId,
  TuiAgent,
  TuiAgentId
} from './types'
import {
  TUI_AGENT_CONFIG,
  isTuiAgent,
  type DraftPasteReadySignal,
  type TuiAgentConfig
} from './tui-agent-config'

export type EffectiveTuiAgent = {
  id: TuiAgentId
  label: string | null
  isCustom: boolean
  detectCmd: string
  launchCmd: string
  expectedProcess: string
  promptInjectionMode: AgentPromptInjectionMode
  draftPromptFlag?: string
  draftPromptEnvVar?: string
  preflightTrust?: TuiAgentConfig['preflightTrust']
  draftPasteReadySignal?: DraftPasteReadySignal
  faviconDomain?: string
  homepageUrl?: string
}

const CUSTOM_AGENT_ID_PREFIX = 'custom:'

export function isCustomTuiAgentId(value: unknown): value is CustomTuiAgentId {
  return typeof value === 'string' && value.startsWith(CUSTOM_AGENT_ID_PREFIX)
}

/** First whitespace-separated token of a command string, stripped of any path prefix.
 *  Used to derive a sensible default detect command / expected process name from a
 *  custom agent's launch command (e.g. `npx -y foo` -> `npx`, `/usr/bin/zsh -l` -> `zsh`). */
export function firstExecutableToken(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) {
    return ''
  }
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  const withoutPath = firstToken.split(/[\\/]/).pop() ?? ''
  return withoutPath
}

function customAgentEffective(agent: CustomTuiAgent): EffectiveTuiAgent {
  const fallbackToken = firstExecutableToken(agent.command)
  return {
    id: agent.id,
    label: agent.label,
    isCustom: true,
    detectCmd: agent.detectCmd?.trim() || fallbackToken,
    launchCmd: agent.command,
    expectedProcess: agent.expectedProcess?.trim() || fallbackToken,
    promptInjectionMode: agent.promptInjectionMode,
    faviconDomain: agent.faviconDomain,
    homepageUrl: agent.homepageUrl
  }
}

function builtInEffective(id: TuiAgent): EffectiveTuiAgent {
  const config = TUI_AGENT_CONFIG[id]
  return {
    id,
    label: null,
    isCustom: false,
    detectCmd: config.detectCmd,
    launchCmd: config.launchCmd,
    expectedProcess: config.expectedProcess,
    promptInjectionMode: config.promptInjectionMode,
    draftPromptFlag: config.draftPromptFlag,
    draftPromptEnvVar: config.draftPromptEnvVar,
    preflightTrust: config.preflightTrust,
    draftPasteReadySignal: config.draftPasteReadySignal
  }
}

export function getEffectiveTuiAgent(
  id: TuiAgentId,
  customAgents: readonly CustomTuiAgent[]
): EffectiveTuiAgent | null {
  if (isCustomTuiAgentId(id)) {
    const match = customAgents.find((agent) => agent.id === id)
    return match ? customAgentEffective(match) : null
  }
  return isTuiAgent(id) ? builtInEffective(id) : null
}

export function listEffectiveTuiAgents(
  customAgents: readonly CustomTuiAgent[]
): EffectiveTuiAgent[] {
  const builtIns = (Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]).map(builtInEffective)
  const customs = customAgents.map(customAgentEffective)
  return [...builtIns, ...customs]
}

/** Generates a stable id with a slug derived from the label and a 6-char base36 suffix
 *  for uniqueness. Labels are user-visible; ids are auto-generated and never editable.
 *  Empty/symbol-only labels fall back to `agent`. */
export function generateCustomTuiAgentId(label: string): CustomTuiAgentId {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent'

  const suffix = randomSuffix(6)
  return `custom:${slug}-${suffix}`
}

function randomSuffix(length: number): string {
  // Why: prefer the crypto-backed RNG when available (renderer + modern Node);
  // fall back to Math.random for environments that lack it (vitest setup files
  // that mock globals, very old runtimes). Suffix is collision-avoidance, not
  // a security token, so the fallback is acceptable.
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto
  if (globalCrypto?.getRandomValues) {
    const bytes = new Uint8Array(length)
    globalCrypto.getRandomValues(bytes)
    let out = ''
    for (const byte of bytes) {
      out += (byte % 36).toString(36)
    }
    return out
  }
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += Math.floor(Math.random() * 36).toString(36)
  }
  return out
}
