import { rm } from 'node:fs/promises'
import { WorkspaceCopyError } from './workspace-copy-errors'
import { parseRobocopySummary } from './workspace-copy-files'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import type { WorkspaceCopyNames } from './workspace-copy-names'
import { findClient } from './workspace-copy-p4'
import {
  isPathUnder,
  P4CLIENT_FROM_CONFIG,
  pathExists,
  type CopySource
} from './workspace-copy-source'
import type { WorkspaceCopySpace } from './workspace-copy-types'

export async function assertNameFree(
  host: WorkspaceCopyHost,
  names: WorkspaceCopyNames,
  cwd: string
) {
  const client = await findClient(host, names.client, cwd)
  const folder = await pathExists(names.copyRoot)
  if (client && folder) {
    throw new WorkspaceCopyError('refused', `A copy named ${names.name} already exists.`)
  }
  if (folder) {
    throw new WorkspaceCopyError(
      'refused',
      `${names.copyRoot} already exists but client ${names.client} does not. Remove the folder or pick another name.`
    )
  }
  if (client) {
    throw new WorkspaceCopyError(
      'refused',
      `Client ${names.client} already exists but its folder does not. Remove that copy first (Clean up lists it), or pick another name.`
    )
  }
}

export async function assertCopyBinding(
  host: WorkspaceCopyHost,
  names: WorkspaceCopyNames
): Promise<void> {
  const set = await host.p4(['set', 'P4CLIENT'], { cwd: names.copyRoot })
  const line = set.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('P4CLIENT='))
  const match = line ? P4CLIENT_FROM_CONFIG.exec(line) : null
  const ok =
    match !== null &&
    match[1].toLowerCase() === names.client.toLowerCase() &&
    isPathUnder(match[2], names.copyRoot)
  if (!ok) {
    throw new WorkspaceCopyError(
      'copy',
      `After the rewrite, P4CLIENT in the copy resolves to '${line ?? 'nothing'}' instead of ${names.client} from a p4config inside the copy.`
    )
  }
}

/** What a create has made so far; a failure removes exactly these. */
export type CreatedParts = { folder: boolean; stream: string | null; client: boolean }

export async function rollBack(
  host: WorkspaceCopyHost,
  source: CopySource,
  names: WorkspaceCopyNames,
  created: CreatedParts,
  error: unknown
): Promise<Error> {
  const left: string[] = []
  if (created.client) {
    const deleted = await host
      .p4(['client', '-d', names.client], { cwd: source.root })
      .catch(() => null)
    if (deleted?.code !== 0) {
      left.push(`client ${names.client}`)
    }
  }
  if (created.stream) {
    const deleted = await host
      .p4(['stream', '-d', created.stream], { cwd: source.root })
      .catch(() => null)
    if (deleted?.code !== 0) {
      left.push(`stream ${created.stream}`)
    }
  }
  if (created.folder && (await pathExists(names.copyRoot))) {
    await host.removeTree(names.copyRoot).catch(() => left.push(`folder ${names.copyRoot}`))
  }
  await rm(names.markerPath, { force: true }).catch(() => {})
  const message = error instanceof Error ? error.message : String(error)
  const suffix =
    left.length > 0
      ? ` Rollback could not remove: ${left.join(', ')}.`
      : ' Everything it created was removed.'
  return new WorkspaceCopyError(
    error instanceof WorkspaceCopyError ? error.kind : 'copy',
    `${message}${suffix}`
  )
}

export function robocopyFailure(code: number | null, stdout: string): string {
  const errors = stdout
    .split(/\r?\n/)
    .filter((line) => /ERROR \d+/.test(line))
    .slice(0, 3)
  return `robocopy failed with exit code ${code ?? 'unknown'}. ${errors.join(' ')}`.trim()
}

export function spaceUsed(
  stdout: string,
  freeBefore: number,
  freeAfter: number
): WorkspaceCopySpace {
  const summary = parseRobocopySummary(stdout)
  const usedBytes = Math.max(0, freeBefore - freeAfter)
  // Each clone still costs about a cluster of metadata per file; a real copy costs its bytes.
  const cloneBudget = summary ? summary.bytes * 0.1 + summary.files * 8192 : null
  return {
    copiedBytes: summary?.bytes ?? null,
    usedBytes,
    cloned:
      cloneBudget === null || summary === null || summary.bytes < 256 * 1024 ** 2
        ? null
        : usedBytes <= cloneBudget,
    freeBytesAfter: freeAfter
  }
}
