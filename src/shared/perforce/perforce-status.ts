import { isAbsolute, relative, sep } from 'node:path'
import type {
  PerforceChangelist,
  PerforceEntry,
  PerforceFileAction,
  PerforceOutsideFile,
  PerforceShelvedFile,
  PerforceStatusResult,
  PerforceWorkspaceInfo
} from './perforce-types'
import { runP4 } from './p4-command'
import { parseTaggedOutput } from './p4-tagged-output'
import { detectPerforceWorkspace, toPosix } from './perforce-detection'
import { previewUnopenedFiles } from './perforce-unopened-preview'
import { HELD_SCAN_MESSAGE, isWorkspaceScanHeld } from './perforce-workspace-scan'

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

export function toRelativePath(cwd: string, localPath: string | undefined): string | null {
  const rel = localPath ? relative(cwd, localPath) : ''
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null
  }
  return toPosix(rel)
}

/** Splits the client's opened files into this folder's entries and the ones outside it. */
export function parseOpenedFiles(
  cwd: string,
  clientRoot: string,
  stdout: string
): { entries: PerforceEntry[]; outside: PerforceOutsideFile[] } {
  const entries: PerforceEntry[] = []
  const outside: PerforceOutsideFile[] = []
  for (const record of parseTaggedOutput(stdout)) {
    const change = record.change
    const changelist = !change || change === 'default' ? 'default' : Number(change)
    const action = toAction(record.action)
    const path = toRelativePath(cwd, record.clientFile)
    if (path) {
      entries.push({
        path,
        depotPath: record.depotFile,
        action,
        group: 'opened',
        changelist,
        fileType: record.type
      })
    } else if (record.depotFile) {
      // Why the check: a multi-root client reports its root as "null".
      const clientPath = isAbsolute(clientRoot)
        ? toRelativePath(clientRoot, record.clientFile)
        : null
      outside.push({
        depotPath: record.depotFile,
        action,
        changelist,
        ...(clientPath ? { clientPath } : {})
      })
    }
  }
  return { entries, outside }
}

export function parseReconcilePreview(cwd: string, stdout: string): PerforceEntry[] {
  const entries: PerforceEntry[] = []
  for (const record of parseTaggedOutput(stdout)) {
    // Tagged output names the local file in clientFile (checked on P4D 2026.1); `-l` adds localFile.
    const path = toRelativePath(cwd, record.localFile ?? record.clientFile)
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
  // Depot paths from p4 are already escaped; escaping them again turns %40 into %2540.
  const result = await runP4(['-ztag', 'where', ...depotPaths], { cwd })
  for (const record of parseTaggedOutput(result.stdout)) {
    const path = toRelativePath(cwd, record.path)
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

/**
 * Tagged fstat of the client's opened files, inside this folder or not: a changelist submits all of
 * them. Only "nothing opened" counts as empty: a timed-out scan must fail the status (the panel keeps
 * its last one), or opened files would vanish and Submit take the wrong path.
 */
async function readOpenedFiles(cwd: string, client: string): Promise<string> {
  const result = await runP4(
    [
      '-ztag',
      'fstat',
      '-Ro',
      '-T',
      'depotFile,clientFile,action,change,type',
      client ? `//${client}/...` : '...'
    ],
    { cwd }
  )
  if (result.code === 0) {
    return result.stdout
  }
  if (/not opened|no such file/i.test(result.stderr)) {
    return ''
  }
  throw new Error(result.stderr.trim() || result.stdout.trim() || 'p4 fstat failed')
}

export async function getPerforceStatus(
  cwd: string,
  options: { waitForUnopened?: boolean } = {}
): Promise<PerforceStatusResult> {
  // Why first: every p4 below runs in the folder, and a copy being deleted must not be held open.
  if (isWorkspaceScanHeld(cwd)) {
    throw new Error(HELD_SCAN_MESSAGE)
  }
  const detected = await detectPerforceWorkspace(cwd)
  if (!detected.isWorkspace) {
    throw new Error(detected.message ?? 'Not a Perforce workspace')
  }
  const streamRead = readStream(cwd)
  const [opened, reconcile, changelists, stream, haveChange] = await Promise.all([
    readOpenedFiles(cwd, detected.info.client),
    // A failed/timed-out unopened scan must not break the panel; degrade to opened + changelists.
    previewUnopenedFiles(cwd, streamRead, options.waitForUnopened === true).catch(() => ({
      code: null,
      stdout: '',
      stderr: ''
    })),
    readChangelists(cwd, detected.info),
    streamRead,
    readHaveChange(cwd)
  ])
  const { entries: openedEntries, outside } = parseOpenedFiles(cwd, detected.info.root, opened)
  const openedPaths = new Set(openedEntries.map((entry) => entry.path))
  const pendingEntries =
    reconcile !== null && reconcile !== 'sparse-stream' && reconcile.code === 0
      ? parseReconcilePreview(cwd, reconcile.stdout).filter((entry) => !openedPaths.has(entry.path))
      : []
  return {
    info: {
      ...detected.info,
      ...(stream ? { stream } : {}),
      ...(haveChange ? { haveChange } : {})
    },
    entries: [...openedEntries, ...pendingEntries],
    changelists,
    openedOutside: outside,
    ...(reconcile === null ? { unopenedPending: true } : {}),
    ...(reconcile === 'sparse-stream' ? { unopenedSkipped: 'sparse-stream' as const } : {})
  }
}

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
