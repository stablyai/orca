import { requireRelativePath } from '../perforce-arguments'
import { COPY_NAME_PATTERN } from './workspace-copy-name-rules'
import type {
  WorkspaceCopyCreateOptions,
  WorkspaceCopyHolderConsent,
  WorkspaceCopyRemovalOptions,
  WorkspaceCopyStreamChoice
} from './workspace-copy-types'

// Validation for copy requests arriving over IPC or the SSH relay; the engine trusts its arguments.

export function requireCopyName(value: unknown): string {
  if (typeof value !== 'string' || !COPY_NAME_PATTERN.test(value)) {
    throw new Error('Copy names are 1-24 letters, digits or hyphens.')
  }
  return value
}

function isDepotStream(value: unknown): value is string {
  return typeof value === 'string' && /^\/\/[^\s@#*%]+$/.test(value)
}

function requireStreamChoice(value: unknown): WorkspaceCopyStreamChoice {
  if (value === undefined) {
    return { kind: 'child' }
  }
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error('Invalid stream choice')
  }
  if (value.kind === 'same-stream') {
    return { kind: 'same-stream' }
  }
  if (value.kind === 'child') {
    const parent = 'parent' in value ? value.parent : undefined
    if (parent === undefined) {
      return { kind: 'child' }
    }
    if (isDepotStream(parent)) {
      return { kind: 'child', parent }
    }
  }
  const stream = 'stream' in value ? value.stream : undefined
  if (value.kind === 'stream' && isDepotStream(stream)) {
    return { kind: 'stream', stream }
  }
  throw new Error('Invalid stream choice')
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function requireCreateOptions(value: unknown): WorkspaceCopyCreateOptions {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid copy options')
  }
  const raw: Record<string, unknown> = { ...value }
  const folders = Array.isArray(raw.extraExcludedFolders) ? raw.extraExcludedFolders : []
  const minFree = raw.minFreeBytes
  return {
    name: requireCopyName(raw.name),
    stream: requireStreamChoice(raw.stream),
    skipPackageCache: optionalBoolean(raw.skipPackageCache),
    extraExcludedFolders: folders.map(requireRelativePath),
    ...(typeof minFree === 'number' && Number.isFinite(minFree) && minFree >= 0
      ? { minFreeBytes: minFree }
      : {})
  }
}

function holderConsents(value: unknown): WorkspaceCopyHolderConsent[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const raw: Record<string, unknown> = { ...entry }
    const { pid, startedAt } = raw
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
      ? [{ pid, startedAt: typeof startedAt === 'number' ? startedAt : null }]
      : []
  })
}

export function requireRemovalOptions(value: unknown): WorkspaceCopyRemovalOptions {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const raw: Record<string, unknown> = { ...value }
  const endHolders = holderConsents(raw.endHolders)
  return {
    revertOpenFiles: optionalBoolean(raw.revertOpenFiles),
    deleteShelves: optionalBoolean(raw.deleteShelves),
    ...(endHolders ? { endHolders } : {})
  }
}
