import { isAbsolute, normalize } from 'node:path'
import type { PerforceEntry } from './perforce-types'

/** Lexical check for workspace-relative paths; the executing host owns the real filesystem. */
export function requireRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('Invalid Perforce file path')
  }
  const normalized = normalize(value)
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${'/'}`)) {
    throw new Error('Perforce file path escapes the workspace')
  }
  if (normalized.startsWith('..\\')) {
    throw new Error('Perforce file path escapes the workspace')
  }
  return normalized
}

export function requireRelativePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('At least one file is required')
  }
  return value.map(requireRelativePath)
}

export function requireDepotPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('At least one shelved file is required')
  }
  return value.map((raw: unknown) => {
    if (typeof raw !== 'string' || !raw.startsWith('//') || raw.includes('\0')) {
      throw new Error('Invalid Perforce depot path')
    }
    return raw
  })
}

export function requireChangelistId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('A pending changelist number is required')
  }
  return value
}

export function requireChangelistTarget(value: unknown): 'default' | number {
  return value === 'default' ? 'default' : requireChangelistId(value)
}

export function requireDescription(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  return value.trim()
}

export function requireDiscardEntries(
  value: unknown
): Pick<PerforceEntry, 'path' | 'group' | 'action'>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('At least one file is required')
  }
  return value.map((raw: unknown) => {
    const entry = typeof raw === 'object' && raw !== null ? raw : {}
    const group = 'group' in entry ? entry.group : undefined
    const action = 'action' in entry ? entry.action : undefined
    if (group !== 'opened' && group !== 'modified' && group !== 'new') {
      throw new Error('Invalid Perforce entry group')
    }
    return {
      path: requireRelativePath('path' in entry ? entry.path : undefined),
      group,
      action: typeof action === 'string' ? toKnownAction(action) : 'unknown'
    }
  })
}

function toKnownAction(action: string): PerforceEntry['action'] {
  return action === 'add' || action === 'branch' ? action : 'edit'
}
