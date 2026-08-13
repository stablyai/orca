import { isTuiAgent } from './tui-agent-config'
import type { GlobalSettings, TuiAgent } from './types'

/** UI sentinel for inherit-global. Never persisted. */
export const AGENT_TERMINAL_THEME_INHERIT = 'inherit' as const

const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'

export type AgentTerminalThemeSlots = { dark?: string; light?: string }
export type AgentTerminalThemes = Partial<Record<TuiAgent, AgentTerminalThemeSlots>>

function sanitizeThemeSelection(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed === AGENT_TERMINAL_THEME_INHERIT) {
    return undefined
  }
  return trimmed
}

function sanitizeSlots(value: unknown): AgentTerminalThemeSlots | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const slots: AgentTerminalThemeSlots = {}
  const dark = sanitizeThemeSelection(record.dark)
  const light = sanitizeThemeSelection(record.light)
  if (dark) {
    slots.dark = dark
  }
  if (light) {
    slots.light = light
  }
  if (!slots.dark && !slots.light) {
    return undefined
  }
  return slots
}

export function normalizeAgentTerminalThemes(value: unknown): AgentTerminalThemes {
  const normalized: AgentTerminalThemes = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized
  }
  for (const [agent, slots] of Object.entries(value)) {
    if (!isTuiAgent(agent)) {
      continue
    }
    const sanitized = sanitizeSlots(slots)
    if (sanitized) {
      normalized[agent] = sanitized
    }
  }
  return normalized
}

export function upsertAgentTerminalThemeSlot(
  current: AgentTerminalThemes | undefined,
  agent: TuiAgent,
  slot: 'dark' | 'light',
  selection: string
): AgentTerminalThemes {
  const next = normalizeAgentTerminalThemes(current)
  const slots: AgentTerminalThemeSlots = { ...next[agent] }
  const sanitized = sanitizeThemeSelection(selection)
  if (!sanitized) {
    delete slots[slot]
  } else {
    slots[slot] = sanitized
  }
  if (!slots.dark && !slots.light) {
    delete next[agent]
  } else {
    next[agent] = slots
  }
  return next
}

export function resolveAgentThemeSelection(
  settings: Pick<
    GlobalSettings,
    | 'agentTerminalThemes'
    | 'terminalThemeDark'
    | 'terminalThemeLight'
    | 'terminalUseSeparateLightTheme'
  >,
  slot: 'dark' | 'light',
  agent?: TuiAgent | null
): string {
  const override = agent ? settings.agentTerminalThemes?.[agent]?.[slot] : undefined
  if (override) {
    return override
  }
  const useLightGlobal = slot === 'light' && settings.terminalUseSeparateLightTheme
  if (useLightGlobal) {
    return settings.terminalThemeLight?.trim() || DEFAULT_TERMINAL_THEME_LIGHT
  }
  return settings.terminalThemeDark?.trim() || DEFAULT_TERMINAL_THEME_DARK
}
