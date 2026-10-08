import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import type { WorkspaceCopyNames } from './workspace-copy-names'
import { findStream } from './workspace-copy-p4'
import type { CopySource } from './workspace-copy-source'
import type { WorkspaceCopyMode, WorkspaceCopyStreamChoice } from './workspace-copy-types'

export type ResolvedStreamChoice = {
  stream: string
  mode: WorkspaceCopyMode
  /** Why this stream, in words for the user. */
  reason: string
  /** Set when the copy's own stream has to be created under this parent first. */
  createUnder: string | null
  /** The copy holds the source's files but sits on another stream: fetch only what differs. */
  align: boolean
}

/** A copy's own stream: `<parent>_wt_<name>`, like a branch per Git worktree. */
export function copyOwnStream(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, '')}_wt_${name}`
}

export function isCopyOwnStream(stream: string, name: string): boolean {
  return stream.toLowerCase().endsWith(`_wt_${name}`.toLowerCase())
}

async function requireStream(host: WorkspaceCopyHost, stream: string, cwd: string): Promise<void> {
  if (!(await findStream(host, stream, cwd))) {
    throw new WorkspaceCopyError('refused', `Stream ${stream} does not exist.`)
  }
}

/** Which stream the copy goes on. A stream of its own under a parent is the default, as Git branches. */
export async function resolveStreamChoice(
  host: WorkspaceCopyHost,
  source: CopySource,
  names: WorkspaceCopyNames,
  choice: WorkspaceCopyStreamChoice
): Promise<ResolvedStreamChoice> {
  if (choice.kind === 'same-stream') {
    return {
      stream: source.stream,
      mode: 'same-stream',
      reason: "the workspace's own stream",
      createUnder: null,
      align: false
    }
  }
  if (choice.kind === 'stream') {
    const stream = choice.stream.replace(/\/+$/, '')
    if (stream.toLowerCase() === source.stream.toLowerCase()) {
      return resolveStreamChoice(host, source, names, { kind: 'same-stream' })
    }
    await requireStream(host, stream, source.root)
    return {
      stream,
      mode: 'other-stream',
      reason: 'the stream you picked',
      createUnder: null,
      align: true
    }
  }
  const parent = (choice.parent ?? source.stream).replace(/\/+$/, '')
  if (parent.toLowerCase() !== source.stream.toLowerCase()) {
    await requireStream(host, parent, source.root)
  }
  const stream = copyOwnStream(parent, names.name)
  // An earlier copy of this name kept its stream because it has submitted work; continue there.
  if (await findStream(host, stream, source.root)) {
    return {
      stream,
      mode: 'child',
      reason: `the earlier copy's stream ${stream}, so its submitted work continues`,
      createUnder: null,
      align: true
    }
  }
  return {
    stream,
    mode: 'child',
    reason: `a new stream of its own under ${parent}`,
    createUnder: parent,
    align: true
  }
}
