import { formatP4Spec, type P4Spec } from './p4-spec'
import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { withSourceLock } from './workspace-copy-lock'
import { withParentClient, type CopyUpTarget } from './workspace-copy-parent-client'
import { copyNamesFor } from './workspace-copy-names'
import {
  findClient,
  findStream,
  openedRecords,
  p4OrThrow,
  p4Tagged,
  streamIntegrationState
} from './workspace-copy-p4'
import { copyOwnStream, isCopyOwnStream } from './workspace-copy-stream-choice'
import { resolveCopySource, type CopySource } from './workspace-copy-source'
import type {
  WorkspaceCopyUpFile,
  WorkspaceCopyUpOptions,
  WorkspaceCopyUpPreview,
  WorkspaceCopyUpResult
} from './workspace-copy-types'
import { parseTaggedOutput } from '../p4-tagged-output'

/**
 * The copy's own stream and its parent, refusing what copy-up cannot carry: a copy on a shared
 * stream, open files (only submitted work moves), and a parent with changes the stream lacks.
 * `upToDate`: the parent already has everything on the stream.
 */
async function resolveTarget(
  host: WorkspaceCopyHost,
  source: CopySource,
  name: string
): Promise<CopyUpTarget & { upToDate: boolean }> {
  const names = copyNamesFor(source, name)
  const client = await findClient(host, names.client, source.root)
  // Why the fallback: a removed copy keeps its stream when it has submitted work.
  const stream = client?.Stream || copyOwnStream(source.stream, name)
  if (!isCopyOwnStream(stream, name)) {
    throw new WorkspaceCopyError(
      'refused',
      `Copy ${name} is on ${stream}, not a stream of its own, so its submits are already there; there is nothing to copy up.`
    )
  }
  if (!(await findStream(host, stream, source.root))) {
    throw new WorkspaceCopyError('refused', `No stream ${stream}.`)
  }
  if (client) {
    const opened = await openedRecords(host, names.client, source.root)
    if (opened.length > 0) {
      throw new WorkspaceCopyError(
        'refused',
        `${opened.length} file(s) are still open in ${names.client}. Submit or revert them in the copy first; copy-up only carries submitted work.`
      )
    }
  }
  const state = await streamIntegrationState(host, stream, source.root)
  if (!state) {
    throw new WorkspaceCopyError('perforce', `p4 istat ${stream} reported no parent.`)
  }
  const { parent } = state
  if (state.fromParent) {
    throw new WorkspaceCopyError(
      'refused',
      `${parent} has changes ${stream} does not. Merge them into the copy first (p4 merge, p4 resolve -am, submit), then copy up again.`
    )
  }
  return { source, name, stream, parent, upToDate: !state.toParent }
}

function copiedFiles(stdout: string): WorkspaceCopyUpFile[] {
  return parseTaggedOutput(stdout)
    .filter((record) => record.depotFile)
    .map((record) => ({
      depotFile: record.depotFile,
      action: record.action ?? ''
    }))
}

async function submittedChanges(
  host: WorkspaceCopyHost,
  target: CopyUpTarget
): Promise<{ change: number; description: string }[]> {
  const records = await p4Tagged(
    host,
    ['changes', '-s', 'submitted', '-l', `${target.stream}/...`],
    target.source.root
  )
  return records
    .filter((record) => record.change)
    .map((record) => ({
      change: Number(record.change),
      description: (record.desc ?? '').trim()
    }))
}

// Files only (-Af): a sparse stream's spec pins its Paths, which must never reach the parent.
const COPY_ARGS = ['copy', '-v', '-Af'] as const

/** What copying copy `name`'s own stream up into its parent would submit, without opening anything. */
export async function previewWorkspaceCopyUp(
  host: WorkspaceCopyHost,
  dir: string,
  name: string
): Promise<WorkspaceCopyUpPreview> {
  const source = await resolveCopySource(host, dir)
  return withSourceLock(source.root, async () => {
    const { upToDate, ...target } = await resolveTarget(host, source, name)
    const base = { name, stream: target.stream, parent: target.parent }
    if (upToDate) {
      return { ...base, upToDate, files: [], changes: [] }
    }
    const files = await withParentClient(host, target, [], async (client) => {
      const result = await host.p4(
        ['-ztag', '-c', client, ...COPY_ARGS, '-n', '-S', target.stream],
        {
          cwd: source.root
        }
      )
      if (result.code !== 0 && !/already integrated/i.test(result.stderr)) {
        throw new WorkspaceCopyError(
          'perforce',
          `p4 copy -n -S ${target.stream} failed: ${result.stderr.trim()}`
        )
      }
      return copiedFiles(result.stdout)
    })
    return {
      ...base,
      upToDate,
      files,
      changes: await submittedChanges(host, target)
    }
  })
}

function defaultDescription(
  target: CopyUpTarget,
  changes: { change: number; description: string }[]
): string {
  const lines = changes.map((c) => `- ${c.change}: ${c.description.split(/\r?\n/)[0] ?? ''}`)
  return [`Copy up ${target.stream} into ${target.parent} (Orca copy ${target.name})`, '', ...lines]
    .join('\n')
    .trim()
}

/** Copies copy `name`'s own stream up into its parent and submits it; refuses on any resolve. */
export async function copyUpWorkspaceCopy(
  host: WorkspaceCopyHost,
  dir: string,
  name: string,
  options: WorkspaceCopyUpOptions = {}
): Promise<WorkspaceCopyUpResult> {
  const source = await resolveCopySource(host, dir)
  return withSourceLock(source.root, async () => {
    const { upToDate, ...target } = await resolveTarget(host, source, name)
    if (upToDate) {
      throw new WorkspaceCopyError(
        'refused',
        `${target.parent} already has everything on ${target.stream}; there is nothing to copy up.`
      )
    }
    const warnings: string[] = []
    const description =
      options.description?.trim() ||
      defaultDescription(target, await submittedChanges(host, target))
    const submitted = await withParentClient(host, target, warnings, async (client) => {
      const cwd = source.root
      const change: P4Spec = new Map()
      change.set('Change', ['new'])
      change.set('Client', [client])
      change.set('User', [source.user])
      change.set('Status', ['new'])
      change.set('Description', description.split(/\r?\n/))
      const made = await p4OrThrow(host, ['-c', client, 'change', '-i'], cwd, formatP4Spec(change))
      const number = /Change (\d+) created/.exec(made)?.[1]
      if (!number) {
        throw new WorkspaceCopyError(
          'perforce',
          `p4 change -i did not report a new changelist: ${made}`
        )
      }
      const copied = await p4OrThrow(
        host,
        ['-ztag', '-c', client, ...COPY_ARGS, '-c', number, '-S', target.stream],
        cwd
      )
      const files = copiedFiles(copied)
      const resolve = await host.p4(['-ztag', '-c', client, 'resolve', '-n', '-c', number], { cwd })
      const unresolved = parseTaggedOutput(resolve.stdout).filter(
        (record) => record.clientFile || record.fromFile
      )
      if (unresolved.length > 0) {
        throw new WorkspaceCopyError(
          'refused',
          `${unresolved.length} file(s) need a resolve, so ${target.parent} moved on during the copy. Nothing was submitted; merge it into the copy and copy up again.`
        )
      }
      const done = parseTaggedOutput(
        await p4OrThrow(host, ['-ztag', '-c', client, 'submit', '-c', number], cwd)
      ).find((record) => record.submittedChange)
      return { files, change: Number(done?.submittedChange ?? number) }
    })
    return {
      name,
      stream: target.stream,
      parent: target.parent,
      submittedChange: submitted.change,
      files: submitted.files,
      warnings
    }
  })
}
