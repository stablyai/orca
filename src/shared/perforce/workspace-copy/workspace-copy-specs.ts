import { formatP4Spec, parseP4Spec } from './p4-spec'
import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import type { WorkspaceCopyNames } from './workspace-copy-names'
import { findClient, p4OrThrow } from './workspace-copy-p4'
import type { CopySource } from './workspace-copy-source'

/**
 * The copy's own sparse stream under `parent`, at the parent's latest change (the server's default
 * pin), as a Git worktree's branch starts from its base. Needs a 2024.1+ server.
 */
export async function createCopyStream(
  host: WorkspaceCopyHost,
  source: CopySource,
  stream: string,
  parent: string
): Promise<void> {
  const template = await p4OrThrow(
    host,
    ['stream', '-o', '-t', 'sparsedev', '-P', parent, stream],
    source.root
  )
  const spec = parseP4Spec(template)
  if (!spec.get('Paths')) {
    throw new WorkspaceCopyError(
      'perforce',
      'The sparse stream template has no Paths field; this server does not support sparse streams (2024.1 or later).'
    )
  }
  spec.set('Description', [`Orca workspace copy of ${source.client}, branched from ${parent}.`])
  spec.delete('Update')
  spec.delete('Access')
  await p4OrThrow(host, ['stream', '-i'], source.root, formatP4Spec(spec))
}

/** The copy's client: the source's options on `stream`, rooted at the copy. */
export async function createCopyClient(
  host: WorkspaceCopyHost,
  source: CopySource,
  names: WorkspaceCopyNames,
  stream: string
): Promise<void> {
  const spec = parseP4Spec(await p4OrThrow(host, ['client', '-o', source.client], source.root))
  // The View names the source client on its right-hand side; a stream client regenerates it on save.
  for (const field of ['Update', 'Access', 'View', 'AltRoots', 'StreamAtChange']) {
    spec.delete(field)
  }
  spec.set('Client', [names.client])
  spec.set('Root', [names.copyRoot])
  spec.set('Stream', [stream])
  spec.set('Description', [`Orca workspace copy of ${source.client}.`])
  await p4OrThrow(host, ['client', '-i'], source.root, formatP4Spec(spec))
  if (!(await findClient(host, names.client, source.root))) {
    throw new WorkspaceCopyError(
      'perforce',
      `p4 client -i reported success but ${names.client} does not exist.`
    )
  }
}
