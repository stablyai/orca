import { isAbsolute, posix, relative, resolve, win32 } from 'node:path'
import type { PerforceEntry } from './perforce-types'

// `C:foo` is relative to drive C's current folder, not to the workspace.
const DRIVE_PREFIX = /^[A-Za-z]:/

/**
 * Lexical check for workspace-relative paths; the executing host owns the real filesystem.
 * Both path flavours are refused because a path checked on one OS may be resolved on another (SSH).
 */
export function requireRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('Invalid Perforce file path')
  }
  if (
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    DRIVE_PREFIX.test(value) ||
    value.split(/[\\/]/).includes('..')
  ) {
    throw new Error('Perforce file path escapes the workspace')
  }
  // p4 reads `...` as every file below; it has no escape for it.
  if (value.includes('...')) {
    throw new Error('Perforce file paths cannot contain "..."')
  }
  // Why forward slashes: the path may be checked on Windows and run on a POSIX host (SSH, an Orca
  // server), and p4 takes `/` on every platform.
  return posix.normalize(value.replaceAll('\\', '/'))
}

/** `filePath` resolved inside `cwd`; refuses anything that would land outside it. */
export function resolveInWorkspace(cwd: string, filePath: string): string {
  const root = resolve(cwd)
  const absolute = resolve(root, requireRelativePath(filePath))
  const inside = relative(root, absolute)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error('Perforce file path escapes the workspace')
  }
  return absolute
}

export function requireRelativePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('At least one file is required')
  }
  return value.map(requireRelativePath)
}

/** A file list that may be empty; anything but an array of relative paths is refused. */
export function requireRelativePathList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected a list of files')
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
    // p4 reports depot paths already escaped (`@` as %40), so a raw wildcard or revision
    // specifier never names one file: `...`, `*`, `%%1`, `@`, `#`.
    if (/\.\.\.|[*@#]|%%/.test(raw)) {
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
