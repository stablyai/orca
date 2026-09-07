import { z } from 'zod'
import { clampUtf8TextPrefix } from '../utf8-byte-limits'

/**
 * Privacy-safe UI focus projection for plugins. Kind is a coarse surface
 * label; title is truncated and never a path or URL. Default off: only
 * plugins that declare `ui:focus` receive this (readContext field + event).
 */

export const PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES = 80
/** Same bound as worktree.* / agent.status.changed join keys. */
export const PLUGIN_FOCUSED_SURFACE_JOIN_ID_MAX_LENGTH = 2048
export const PLUGIN_FOCUSED_SURFACE_KINDS = [
  'terminal',
  'agent',
  'browser',
  'editor',
  'simulator',
  'command-palette'
] as const

export type PluginFocusedSurfaceKind = (typeof PLUGIN_FOCUSED_SURFACE_KINDS)[number]

export const pluginFocusedSurfaceKindSchema = z.enum(PLUGIN_FOCUSED_SURFACE_KINDS)

const pluginFocusJoinIdSchema = z.string().min(1).max(PLUGIN_FOCUSED_SURFACE_JOIN_ID_MAX_LENGTH)

export const pluginFocusedSurfaceSchema = z
  .object({
    kind: pluginFocusedSurfaceKindSchema,
    title: z.string().max(PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES).nullable(),
    /** Session-scoped opaque token. Path-bearing host ids are never forwarded. */
    worktreeId: pluginFocusJoinIdSchema.nullable().optional(),
    /** Focused agent-session tab id; join paneKey with `${agentId}:`. */
    agentId: pluginFocusJoinIdSchema.nullable().optional()
  })
  .strict()

export type PluginFocusedSurface = z.infer<typeof pluginFocusedSurfaceSchema>

export const pluginUiFocusChangedPayloadSchema = z
  .object({
    focusedSurface: pluginFocusedSurfaceSchema.nullable(),
    receivedAt: z.number().finite().positive()
  })
  .strict()

export type PluginUiFocusChangedPayload = z.infer<typeof pluginUiFocusChangedPayloadSchema>

export const pluginUiFocusReportSchema = z
  .object({
    windowFocused: z.boolean().optional(),
    kind: pluginFocusedSurfaceKindSchema.optional(),
    title: z.string().max(4096).nullable().optional(),
    worktreeId: z.string().max(PLUGIN_FOCUSED_SURFACE_JOIN_ID_MAX_LENGTH).nullable().optional(),
    agentId: z.string().max(PLUGIN_FOCUSED_SURFACE_JOIN_ID_MAX_LENGTH).nullable().optional()
  })
  .strict()

export type PluginUiFocusReport = z.infer<typeof pluginUiFocusReportSchema>

/** Host worktree ids are `${repoId}::${path}` and must not reach plugins as-is. */
export function pluginJoinIdLooksPathBearing(value: string): boolean {
  return /[\\/]/.test(value) || /::[A-Za-z]:/.test(value)
}

/** Process-local raw→token map so the same worktree keeps the same join key. */
export class PluginOpaqueJoinKeyMap {
  private readonly tokens = new Map<string, string>()
  private next = 0

  tokenFor(raw: string): string {
    const existing = this.tokens.get(raw)
    if (existing) {
      return existing
    }
    this.next += 1
    const token = `pj_${this.next.toString(36)}`
    this.tokens.set(raw, token)
    return token
  }
}

export function projectPluginFocusJoinId(
  raw: string | null | undefined,
  joinKeys?: PluginOpaqueJoinKeyMap
): string | null {
  if (raw == null) {
    return null
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > PLUGIN_FOCUSED_SURFACE_JOIN_ID_MAX_LENGTH) {
    return null
  }
  if (!pluginJoinIdLooksPathBearing(trimmed)) {
    return trimmed
  }
  return joinKeys?.tokenFor(trimmed) ?? null
}

export function projectPluginFocusedTitle(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  return clampUtf8TextPrefix(
    sanitizePluginFocusedTitle(trimmed),
    PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES
  )
}

function sanitizePluginFocusedTitle(value: string): string {
  const hostname = hostnameFromHttpUrl(value)
  if (hostname) {
    return hostname
  }
  if (/[\\/]/.test(value)) {
    const withoutTrailing = value.replace(/[\\/]+$/, '')
    const base = withoutTrailing.split(/[\\/]/).pop()
    return base && base.length > 0 ? base : withoutTrailing
  }
  return value
}

function hostnameFromHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return url.hostname || null
  } catch {
    return null
  }
}

export function projectPluginUiFocusReport(
  raw: unknown,
  joinKeys?: PluginOpaqueJoinKeyMap
): PluginFocusedSurface | null {
  const parsed = pluginUiFocusReportSchema.safeParse(raw)
  if (!parsed.success || parsed.data.windowFocused === false || parsed.data.kind === undefined) {
    return null
  }
  const surface: PluginFocusedSurface = {
    kind: parsed.data.kind,
    title: projectPluginFocusedTitle(parsed.data.title)
  }
  const worktreeId = projectPluginFocusJoinId(parsed.data.worktreeId, joinKeys)
  if (worktreeId) {
    surface.worktreeId = worktreeId
  }
  if (parsed.data.kind === 'agent') {
    surface.agentId = projectPluginFocusJoinId(parsed.data.agentId, joinKeys)
  }
  return surface
}

export function pluginFocusedSurfacesEqual(
  left: PluginFocusedSurface | null,
  right: PluginFocusedSurface | null
): boolean {
  if (left === right) {
    return true
  }
  if (left === null || right === null) {
    return false
  }
  return (
    left.kind === right.kind &&
    left.title === right.title &&
    (left.worktreeId ?? null) === (right.worktreeId ?? null) &&
    (left.agentId ?? null) === (right.agentId ?? null)
  )
}
