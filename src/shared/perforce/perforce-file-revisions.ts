import { readFile, stat } from 'node:fs/promises'
import type { GitDiffResult } from '../git-diff-compare-types'
import type { PerforceHistoryEntry } from './perforce-types'
import { escapeP4FileArg, runP4, runP4OrThrow } from './p4-command'
import { currentPerforceSettings } from './p4-settings-context'
import { parseShelvedDiffPath } from './perforce-shelved-paths'
import { parseTaggedOutput } from './p4-tagged-output'
import { resolveReadableInWorkspace } from './perforce-workspace-real-path'

const MAX_TEXT_DIFF_BYTES = 5 * 1024 * 1024

function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes('\0')
}

async function readWorkingFile(cwd: string, filePath: string): Promise<string | null> {
  const absolute = await resolveReadableInWorkspace(cwd, filePath)
  if (!absolute) {
    return null
  }
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
