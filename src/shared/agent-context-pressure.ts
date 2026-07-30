// ─── Agent context-window pressure ───────────────────────────────────────────
// Provider-reported context usage carried on an agent-session status entry,
// plus the traffic-light computation (green/yellow/red) against the effective
// limit: min(user soft cap, provider-reported max, model-table fallback).
// No data → null; the UI must show "unknown", never an invented value.

import { getModelContextWindowTokens } from './model-context-windows'

/** Provider-reported context usage for one agent session. */
export type AgentContextUsage = {
  /** Tokens currently occupying the context window. */
  usedTokens: number
  /** Provider-reported context-window size, when the harness exposes one. */
  maxTokens?: number
  /** Whether occupancy was reported directly or derived from a provider percentage. */
  usedTokensSource?: 'provider' | 'derived-percent'
  /** Explicit provider identity reported by the harness. */
  providerId?: string
}

/** Traffic light: green / yellow / red. */
export type ContextPressureLevel = 'ok' | 'warning' | 'critical'

export type ContextPressureConfig = {
  warnPercent: number
  criticalPercent: number
  /** Absolute caps. Reserved keys: global, provider:<id>, agent:<type>, model:<id>.
   *  Unprefixed keys remain backward-compatible model/agent keys. */
  softLimits?: Record<string, number>
}

export type ContextPressureLimitSource = 'provider' | 'model' | 'soft-cap'

export type ContextPressureSnapshot = {
  level: ContextPressureLevel
  usedTokens: number
  limitTokens: number
  usedPercent: number
  usedTokensSource?: AgentContextUsage['usedTokensSource']
  /** Which candidate actually bound the effective limit. */
  limitSource: ContextPressureLimitSource
}

export const DEFAULT_CONTEXT_PRESSURE_WARN_PERCENT = 70
export const DEFAULT_CONTEXT_PRESSURE_CRITICAL_PERCENT = 90

/** Token-count ceiling for persisted/IPC usage numbers. Bounds hostile payloads
 *  while comfortably covering real context windows (1M) with headroom. */
export const AGENT_CONTEXT_USAGE_MAX_TOKENS = 1_000_000_000

/** Bounds for the user-configured soft-limits record (settings sanitation). */
export const CONTEXT_PRESSURE_SOFT_LIMIT_MAX_ENTRIES = 64
export const CONTEXT_PRESSURE_SOFT_LIMIT_KEY_MAX_LENGTH = 120

function clampTokens(value: number): number {
  return Math.min(Math.floor(value), AGENT_CONTEXT_USAGE_MAX_TOKENS)
}

export function normalizeContextPressureSoftLimitKey(value: string): string {
  const trimmed = value.trim().toLowerCase()
  const separator = trimmed.indexOf(':')
  if (separator < 0) {
    return trimmed.replace(/\./g, '-')
  }
  const scope = trimmed.slice(0, separator)
  const identity = trimmed.slice(separator + 1).trim()
  return `${scope}:${scope === 'model' ? identity.replace(/\./g, '-') : identity}`
}

/** Percent threshold for pressure levels: integer 1–100; anything else → fallback. */
export function normalizeContextPressurePercent(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(100, Math.max(1, Math.round(value)))
}

/** Sanitize a user-configured soft-limits record: positive finite integer caps,
 *  bounded key length and entry count; invalid entries dropped. */
export function normalizeContextPressureSoftLimits(value: unknown): Record<string, number> {
  const normalized: Record<string, number> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized
  }
  let entries = 0
  for (const [rawKey, rawLimit] of Object.entries(value)) {
    const key = normalizeContextPressureSoftLimitKey(rawKey)
    if (
      key.length === 0 ||
      key.length > CONTEXT_PRESSURE_SOFT_LIMIT_KEY_MAX_LENGTH ||
      typeof rawLimit !== 'number' ||
      !Number.isFinite(rawLimit) ||
      rawLimit < 1
    ) {
      continue
    }
    normalized[key] = clampTokens(rawLimit)
    entries += 1
    if (entries >= CONTEXT_PRESSURE_SOFT_LIMIT_MAX_ENTRIES) {
      break
    }
  }
  return normalized
}

/**
 * Validate/normalize a contextUsage field from an untrusted status payload.
 * undefined = "no update" (field absent), null = explicit clear, object =
 * new reading. Invalid shapes/numbers are dropped to undefined; a bad
 * maxTokens is dropped alone so a valid usedTokens still gets through.
 */
export function normalizeAgentContextUsage(value: unknown): AgentContextUsage | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const obj = value as Record<string, unknown>
  if (
    typeof obj.usedTokens !== 'number' ||
    !Number.isFinite(obj.usedTokens) ||
    obj.usedTokens < 0
  ) {
    return undefined
  }
  const usedTokens = clampTokens(obj.usedTokens)
  const maxTokens =
    typeof obj.maxTokens === 'number' && Number.isFinite(obj.maxTokens) && obj.maxTokens >= 1
      ? clampTokens(obj.maxTokens)
      : undefined
  const usedTokensSource =
    obj.usedTokensSource === 'derived-percent' || obj.usedTokensSource === 'provider'
      ? obj.usedTokensSource
      : undefined
  const providerId =
    typeof obj.providerId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(obj.providerId.trim())
      ? obj.providerId.trim().toLowerCase()
      : undefined
  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(usedTokensSource ? { usedTokensSource } : {}),
    ...(providerId ? { providerId } : {})
  }
}

/** Structural equality so stores can reuse the previous object reference (and
 *  skip fanout) when nothing changed. null and undefined both mean "no data". */
export function agentContextUsageEqual(
  a: AgentContextUsage | null | undefined,
  b: AgentContextUsage | null | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return !a && !b
  }
  return (
    a.usedTokens === b.usedTokens &&
    a.maxTokens === b.maxTokens &&
    a.usedTokensSource === b.usedTokensSource &&
    a.providerId === b.providerId
  )
}

/** The GlobalSettings slice that configures context pressure (gate + thresholds). */
export type ContextPressureSettings = {
  experimentalContextPressure?: boolean
  contextPressureWarnPercent?: number
  contextPressureCriticalPercent?: number
  contextPressureSoftLimits?: Record<string, number>
}

/**
 * Config from settings, or null when the experimental master flag is off.
 * Single gate+defaults resolution shared by the renderer selection layer and
 * main's mobile worktree.ps agent rows so all surfaces agree.
 */
export function resolveContextPressureConfigFromSettings(
  settings: ContextPressureSettings | null | undefined
): ContextPressureConfig | null {
  if (settings?.experimentalContextPressure !== true) {
    return null
  }
  return {
    warnPercent: settings.contextPressureWarnPercent ?? DEFAULT_CONTEXT_PRESSURE_WARN_PERCENT,
    criticalPercent:
      settings.contextPressureCriticalPercent ?? DEFAULT_CONTEXT_PRESSURE_CRITICAL_PERCENT,
    softLimits: settings.contextPressureSoftLimits
  }
}

type LimitCandidate = { limitTokens: number; limitSource: ContextPressureLimitSource }

function resolveSoftCap(
  softLimits: Record<string, number> | undefined,
  model: string | null | undefined,
  agentType: string | null | undefined,
  provider: string | null | undefined
): number | undefined {
  if (!softLimits) {
    return undefined
  }
  const normalizedModel = model?.trim().toLowerCase().replace(/\./g, '-')
  const entries = Object.entries(softLimits).map(
    ([key, cap]) => [key.trim().toLowerCase(), cap] as const
  )
  if (normalizedModel) {
    let best: { length: number; cap: number } | undefined
    for (const [rawKey, cap] of entries) {
      const key = rawKey.startsWith('model:') ? rawKey.slice(6) : rawKey.includes(':') ? '' : rawKey
      const normalizedKey = key.replace(/\./g, '-')
      if (
        normalizedKey &&
        typeof cap === 'number' &&
        Number.isFinite(cap) &&
        cap >= 1 &&
        matchesSoftLimitModel(normalizedModel, normalizedKey) &&
        (!best || normalizedKey.length > best.length)
      ) {
        best = { length: normalizedKey.length, cap }
      }
    }
    if (best) {
      return Math.floor(best.cap)
    }
  }
  for (const key of [
    provider ? `provider:${provider.trim().toLowerCase()}` : null,
    agentType ? `agent:${agentType.trim().toLowerCase()}` : null,
    agentType?.trim().toLowerCase(),
    'global'
  ]) {
    if (!key) {
      continue
    }
    const cap = entries.find(([candidate]) => candidate === key)?.[1]
    if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 1) {
      return Math.floor(cap)
    }
  }
  return undefined
}

function matchesSoftLimitModel(model: string, key: string): boolean {
  if (model === key) {
    return true
  }
  if (!model.startsWith(key)) {
    return false
  }
  const next = model.charAt(key.length)
  return next === '-' || next === '[' || next === ':' || next === '/'
}

/**
 * Compute the traffic-light snapshot for a session, or null when usage or an
 * effective limit is unknown (honest fallback — no invented values).
 */
export function resolveContextPressure(input: {
  usage: AgentContextUsage | null | undefined
  model?: string | null
  agentType?: string | null
  /** Explicit provider identity reported by the harness; never inferred from agentType. */
  provider?: string | null
  config: ContextPressureConfig
}): ContextPressureSnapshot | null {
  const usage = input.usage
  if (
    !usage ||
    typeof usage.usedTokens !== 'number' ||
    !Number.isFinite(usage.usedTokens) ||
    usage.usedTokens < 0
  ) {
    return null
  }
  const usedTokens = Math.floor(usage.usedTokens)

  // Why this order: on ties the earlier source is reported — provider data is
  // ground truth, and a soft cap only "binds" when it actually lowers the limit.
  const candidates: LimitCandidate[] = []
  if (
    typeof usage.maxTokens === 'number' &&
    Number.isFinite(usage.maxTokens) &&
    usage.maxTokens >= 1
  ) {
    candidates.push({ limitTokens: Math.floor(usage.maxTokens), limitSource: 'provider' })
  }
  const modelWindow = input.model ? getModelContextWindowTokens(input.model) : undefined
  if (modelWindow !== undefined) {
    candidates.push({ limitTokens: modelWindow, limitSource: 'model' })
  }
  const softCap = resolveSoftCap(
    input.config.softLimits,
    input.model,
    input.agentType,
    input.provider ?? usage.providerId
  )
  if (softCap !== undefined) {
    candidates.push({ limitTokens: softCap, limitSource: 'soft-cap' })
  }
  let bound: LimitCandidate | null = null
  for (const candidate of candidates) {
    if (!bound || candidate.limitTokens < bound.limitTokens) {
      bound = candidate
    }
  }
  if (!bound) {
    return null
  }

  const warnPercent = normalizeContextPressurePercent(
    input.config.warnPercent,
    DEFAULT_CONTEXT_PRESSURE_WARN_PERCENT
  )
  // Why max(): inverted thresholds (warn > critical) degrade gracefully instead
  // of creating a band where "critical" never triggers above "warning".
  const criticalPercent = Math.max(
    warnPercent,
    normalizeContextPressurePercent(
      input.config.criticalPercent,
      DEFAULT_CONTEXT_PRESSURE_CRITICAL_PERCENT
    )
  )

  const usedPercent = (usedTokens / bound.limitTokens) * 100
  const level: ContextPressureLevel =
    usedPercent >= criticalPercent ? 'critical' : usedPercent >= warnPercent ? 'warning' : 'ok'
  return {
    level,
    usedTokens,
    limitTokens: bound.limitTokens,
    usedPercent,
    ...(usage.usedTokensSource ? { usedTokensSource: usage.usedTokensSource } : {}),
    limitSource: bound.limitSource
  }
}
