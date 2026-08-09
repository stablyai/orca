import type { Breakpoint } from '../../../shared/debug-breakpoint-types'

export const DEBUG_BREAKPOINTS_STORAGE_KEY = 'orca.debug.breakpoints.v1'

type BreakpointStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function isBreakpoint(value: unknown): value is Breakpoint {
  if (!value || typeof value !== 'object') {
    return false
  }
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.path === 'string' &&
    typeof v.line === 'number' &&
    Number.isInteger(v.line) &&
    v.line >= 1 &&
    typeof v.verified === 'boolean'
  )
}

export function normalizeBreakpointsByPath(value: unknown): Record<string, Breakpoint[]> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const result: Record<string, Breakpoint[]> = {}
  for (const [path, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue
    }
    // Why: a path key must own only breakpoints stamped with that same path — guards against corrupted/hand-edited storage.
    const breakpoints = list.filter(isBreakpoint).filter((bp) => bp.path === path)
    if (breakpoints.length > 0) {
      result[path] = breakpoints
    }
  }
  return result
}

function getRendererStorage(): BreakpointStorage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readDebugBreakpoints(
  storage: BreakpointStorage | null = getRendererStorage()
): Record<string, Breakpoint[]> {
  if (!storage) {
    return {}
  }
  try {
    const raw = storage.getItem(DEBUG_BREAKPOINTS_STORAGE_KEY)
    return raw ? normalizeBreakpointsByPath(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

export function writeDebugBreakpoints(
  breakpointsByPath: Record<string, Breakpoint[]>,
  storage: BreakpointStorage | null = getRendererStorage()
): boolean {
  if (!storage) {
    return false
  }
  try {
    storage.setItem(DEBUG_BREAKPOINTS_STORAGE_KEY, JSON.stringify(breakpointsByPath))
    return true
  } catch {
    return false
  }
}
