import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatP4Spec, parseP4Spec } from './p4-spec'
import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { findClient, openedRecords, p4OrThrow, pendingChanges } from './workspace-copy-p4'
import type { CopySource } from './workspace-copy-source'

/** A copy's own stream on its way up into `parent`. */
export type CopyUpTarget = {
  source: CopySource
  name: string
  stream: string
  parent: string
}

async function deleteClient(host: WorkspaceCopyHost, client: string, cwd: string): Promise<void> {
  for (const { change } of await pendingChanges(host, client, cwd)) {
    await host.p4(['-c', client, 'change', '-d', String(change)], { cwd })
  }
  await p4OrThrow(host, ['client', '-d', client], cwd)
}

/**
 * Runs `work` in a throwaway client on the parent, never the developer's workspace: open files there
 * make p4 copy skip those targets and still exit 0, and it may not be on the parent at all. Its root
 * is an empty folder and the copy is virtual, so nothing is synced. Everything is deleted afterwards,
 * on failure too.
 */
export async function withParentClient<T>(
  host: WorkspaceCopyHost,
  target: CopyUpTarget,
  warnings: string[],
  work: (client: string) => Promise<T>
): Promise<T> {
  const cwd = target.source.root
  const client = `${target.source.client}_up_${target.name}`
  if (await findClient(host, client, cwd)) {
    if ((await openedRecords(host, client, cwd)).length > 0) {
      throw new WorkspaceCopyError(
        'refused',
        `A client ${client} from an earlier copy-up still has open files. Check them (p4 opened -C ${client}), revert them and delete the client.`
      )
    }
    await deleteClient(host, client, cwd)
  }
  const root = await mkdtemp(join(tmpdir(), `orca-p4-copy-up-${target.name}-`))
  let created = false
  try {
    const spec = parseP4Spec(
      await p4OrThrow(host, ['client', '-o', '-S', target.parent, client], cwd)
    )
    for (const field of ['Update', 'Access', 'View', 'AltRoots', 'StreamAtChange']) {
      spec.delete(field)
    }
    spec.set('Client', [client])
    spec.set('Root', [root])
    spec.set('Stream', [target.parent])
    spec.set('Description', [`Orca copy-up of ${target.stream}; deleted when the run ends.`])
    await p4OrThrow(host, ['client', '-i'], cwd, formatP4Spec(spec))
    if (!(await findClient(host, client, cwd))) {
      throw new WorkspaceCopyError(
        'perforce',
        `p4 client -i reported success but ${client} does not exist.`
      )
    }
    created = true
    return await work(client)
  } finally {
    if (created) {
      await host.p4(['-c', client, 'revert', '-k', `//${client}/...`], { cwd })
      await deleteClient(host, client, cwd).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        warnings.push(
          `Could not delete the temporary client ${client} (${detail}); delete it in P4V.`
        )
      })
    }
    await rm(root, { recursive: true, force: true })
  }
}
