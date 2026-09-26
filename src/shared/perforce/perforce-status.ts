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
import { escapeP4FileArg, runP4, runP4OrThrow, type P4CommandResult } from './p4-command'
import { currentPerforceSettings } from './p4-settings-context'
import { parseShelvedDiffPath } from './perforce-shelved-paths'
import { parseTaggedOutput } from './p4-tagged-output'
import { detectPerforceWorkspace, toPosix } from './perforce-detection'

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
  const localPaths = await mapDepotToWorkspace(
    cwd,
    [...shelved.values()].flatMap((files) => files.map((file) => file.depotPath))
  )
  return changelists.map((changelist) => ({
    ...changelist,
    shelvedFiles: (shelved.get(changelist.id) ?? []).map((file) => {
      const path = localPaths.get(file.depotPath)
      return path ? { ...file, path } : file
    })
  }))
}

async function mapDepotToWorkspace(
  cwd: string,
  depotPaths: string[]
): Promise<Map<string, string>> {
  const mapped = new Map<string, string>()
  if (depotPaths.length === 0) {
    return mapped
  }
  const result = await runP4(['-ztag', 'where', ...depotPaths.map(escapeP4FileArg)], { cwd })
  for (const record of parseTaggedOutput(result.stdout)) {
    const path = record.path ? toRelativePath(cwd, record.path) : null
    if (record.depotFile && path) {
      mapped.set(record.depotFile, path)
    }
  }
  return mapped
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

/** Previews unopened changes; skipped entirely when the user hides both unopened sections. */
async function runReconcilePreview(cwd: string): Promise<P4CommandResult> {
  const settings = currentPerforceSettings()
  const flags = [
    ...(settings.showNewFiles ? ['-a'] : []),
    ...(settings.showModifiedNotOpened ? ['-e', '-d'] : [])
  ]
  if (flags.length === 0) {
    return { code: 0, stdout: '', stderr: '' }
  }
  return runP4(['-ztag', 'reconcile', '-n', ...flags, '...'], {
    cwd,
    timeoutMs: settings.statusScanTimeoutSeconds * 1000
  })
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
    runReconcilePreview(cwd),
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

/** Diff of the workspace file against the synced revision (`#have`) or the depot head, per settings. */
export async function getPerforceDiff(cwd: string, rawFilePath: string): Promise<GitDiffResult> {
  const shelved = parseShelvedDiffPath(rawFilePath)
  const filePath = shelved?.path ?? rawFilePath
  const revision = shelved
    ? `@=${shelved.changelist}`
    : currentPerforceSettings().compareAgainst === 'head'
      ? '#head'
      : '#have'
  const printed = await runP4(['print', '-q', `${escapeP4FileArg(filePath)}${revision}`], { cwd })
  // Why: a file with no have revision (new, or not in the depot) diffs against empty.
  const original = printed.code === 0 ? printed.stdout : ''
  const modified = shelved?.viewOnly ? original : await readWorkingFile(cwd, filePath)
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

/** Unified diff text of opened files, used to summarize a changelist. */
export async function getPerforceDiffText(
  cwd: string,
  filePaths: readonly string[]
): Promise<string> {
  const result = await runP4(['diff', '-du', ...filePaths.map(escapeP4FileArg)], { cwd })
  return result.stdout
}

/** `p4 info` for the connection test; reports the server and client even outside a workspace. */
export async function getPerforceInfo(
  cwd: string
): Promise<{ success: true; info: PerforceWorkspaceInfo } | { success: false; error: string }> {
  try {
    const result = await runP4(['-ztag', 'info'], { cwd, timeoutMs: 15_000 })
    if (result.code !== 0) {
      return { success: false, error: result.stderr.trim() || 'p4 info failed' }
    }
    const record = parseTaggedOutput(result.stdout)[0]
    return {
      success: true,
      info: {
        client: record?.clientName ?? '',
        user: record?.userName ?? '',
        port: record?.serverAddress ?? '',
        root: record?.clientRoot ?? ''
      }
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
