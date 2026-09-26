import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GitDiffResult } from '../git-diff-compare-types'
import type {
  PerforceChangelist,
  PerforceEntry,
  PerforceFileAction,
  PerforceHistoryEntry,
  PerforceShelvedFile,
  PerforceStatusResult,
  PerforceWorkspaceInfo
} from './perforce-types'
import { escapeP4FileArg, runP4, runP4OrThrow } from './p4-command'
import { parseTaggedOutput } from './p4-tagged-output'
import { detectPerforceWorkspace, toPosix } from './perforce-detection'

const RECONCILE_TIMEOUT_MS = 180_000
const MAX_TEXT_DIFF_BYTES = 5 * 1024 * 1024

const KNOWN_ACTIONS: readonly PerforceFileAction[] = [
  'add',
  'edit',
  'delete',
  'branch',
  'integrate',
  'move/add',
  'move/delete',
  'archive',
  'purge',
  'import'
]

function toAction(raw: string | undefined): PerforceFileAction {
  return KNOWN_ACTIONS.find((action) => action === raw) ?? 'unknown'
}

function toRelativePath(cwd: string, localPath: string): string | null {
  const rel = relative(cwd, localPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return null
  }
  return toPosix(rel)
}

export function parseOpenedEntries(cwd: string, stdout: string): PerforceEntry[] {
  const entries: PerforceEntry[] = []
  for (const record of parseTaggedOutput(stdout)) {
    const path = record.clientFile ? toRelativePath(cwd, record.clientFile) : null
    if (!path) {
      continue
    }
    const change = record.change
    entries.push({
      path,
      depotPath: record.depotFile,
      action: toAction(record.action),
      group: 'opened',
      changelist: !change || change === 'default' ? 'default' : Number(change),
      fileType: record.type
    })
  }
  return entries
}

export function parseReconcilePreview(cwd: string, stdout: string): PerforceEntry[] {
  const entries: PerforceEntry[] = []
  for (const record of parseTaggedOutput(stdout)) {
    const path = record.clientFile ? toRelativePath(cwd, record.clientFile) : null
    if (!path) {
      continue
    }
    const action = toAction(record.action)
    entries.push({
      path,
      depotPath: record.depotFile,
      action,
      group: action === 'add' ? 'new' : 'modified',
      fileType: record.type
    })
  }
  return entries
}

export function parseShelvedFiles(stdout: string): Map<number, PerforceShelvedFile[]> {
  const shelved = new Map<number, PerforceShelvedFile[]>()
  for (const record of parseTaggedOutput(stdout)) {
    const files: PerforceShelvedFile[] = []
    for (let index = 0; record[`depotFile${index}`] !== undefined; index += 1) {
      files.push({
        depotPath: record[`depotFile${index}`] ?? '',
        action: toAction(record[`action${index}`])
      })
    }
    if (record.change && files.length > 0) {
      shelved.set(Number(record.change), files)
    }
  }
  return shelved
}

async function readChangelists(
  cwd: string,
  info: PerforceWorkspaceInfo
): Promise<PerforceChangelist[]> {
  const result = await runP4(
    ['-ztag', 'changes', '-s', 'pending', '-l', '-c', info.client, '-u', info.user],
    { cwd }
  )
  if (result.code !== 0) {
    return []
  }
  const changelists = parseTaggedOutput(result.stdout).map((record): PerforceChangelist => ({
    id: Number(record.change),
    description: (record.desc ?? '').trim(),
    shelvedFiles: []
  }))
  if (changelists.length === 0) {
    return changelists
  }
  // Why: `describe -S` reports a per-change error for changelists without a shelf, so only stdout is parsed.
  const described = await runP4(
    ['-ztag', 'describe', '-S', '-s', ...changelists.map((changelist) => String(changelist.id))],
    { cwd }
  )
  const shelved = parseShelvedFiles(described.stdout)
  return changelists.map((changelist) => ({
    ...changelist,
    shelvedFiles: shelved.get(changelist.id) ?? []
  }))
}

async function readStream(cwd: string): Promise<string | undefined> {
  const result = await runP4(['-ztag', 'client', '-o'], { cwd })
  return result.code === 0 ? parseTaggedOutput(result.stdout)[0]?.Stream : undefined
}

async function readHaveChange(cwd: string): Promise<number | undefined> {
  const result = await runP4(['-ztag', 'changes', '-m1', '-s', 'submitted', '...#have'], { cwd })
  const change = result.code === 0 ? parseTaggedOutput(result.stdout)[0]?.change : undefined
  return change ? Number(change) : undefined
}

export async function getPerforceStatus(cwd: string): Promise<PerforceStatusResult> {
  const detected = await detectPerforceWorkspace(cwd)
  if (!detected.isWorkspace) {
    throw new Error(detected.message ?? 'Not a Perforce workspace')
  }
  const [opened, reconcile, changelists, stream, haveChange] = await Promise.all([
    runP4OrThrow(
      ['-ztag', 'fstat', '-Ro', '-T', 'depotFile,clientFile,action,change,type', '...'],
      { cwd }
    ).catch(() => ''),
    runP4(['-ztag', 'reconcile', '-n', '-a', '-e', '-d', '...'], {
      cwd,
      timeoutMs: RECONCILE_TIMEOUT_MS
    }),
    readChangelists(cwd, detected.info),
    readStream(cwd),
    readHaveChange(cwd)
  ])
  const openedEntries = parseOpenedEntries(cwd, opened)
  const openedPaths = new Set(openedEntries.map((entry) => entry.path))
  const pendingEntries =
    reconcile.code === 0
      ? parseReconcilePreview(cwd, reconcile.stdout).filter((entry) => !openedPaths.has(entry.path))
      : []
  return {
    info: {
      ...detected.info,
      ...(stream ? { stream } : {}),
      ...(haveChange ? { haveChange } : {})
    },
    entries: [...openedEntries, ...pendingEntries],
    changelists
  }
}

function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes('\0')
}

async function readWorkingFile(cwd: string, filePath: string): Promise<string | null> {
  const absolute = resolve(cwd, filePath)
  try {
    const info = await stat(absolute)
    if (!info.isFile()) {
      return null
    }
    if (info.size > MAX_TEXT_DIFF_BYTES) {
      return '\0'
    }
    return await readFile(absolute, 'utf8')
  } catch {
    return null
  }
}

/** Diff of the workspace file against the revision last synced (`#have`). */
export async function getPerforceDiff(cwd: string, filePath: string): Promise<GitDiffResult> {
  const printed = await runP4(['print', '-q', `${escapeP4FileArg(filePath)}#have`], { cwd })
  // Why: a file with no have revision (new, or not in the depot) diffs against empty.
  const original = printed.code === 0 ? printed.stdout : ''
  const modified = await readWorkingFile(cwd, filePath)
  if (looksBinary(original) || (modified !== null && looksBinary(modified))) {
    return {
      kind: 'binary',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: true,
      modifiedIsBinary: true,
      ...(modified === null ? { modifiedDeleted: true } : {})
    }
  }
  return {
    kind: 'text',
    originalContent: original,
    modifiedContent: modified ?? '',
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

export async function getPerforceHistory(
  cwd: string,
  limit: number
): Promise<PerforceHistoryEntry[]> {
  const output = await runP4OrThrow(
    ['-ztag', 'changes', '-m', String(limit), '-s', 'submitted', '-l', '...'],
    { cwd }
  )
  return parseTaggedOutput(output).map((record) => ({
    change: Number(record.change),
    user: record.user ?? '',
    client: record.client ?? '',
    time: Number(record.time ?? 0),
    description: (record.desc ?? '').trim()
  }))
}
