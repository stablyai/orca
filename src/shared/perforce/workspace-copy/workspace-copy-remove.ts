import { randomBytes } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { withSourceLock } from './workspace-copy-lock'
import { holdWorkspaceScansUnder } from '../perforce-workspace-scan'
import { assertCopyName } from './workspace-copy-names'
import { p4OrThrow } from './workspace-copy-p4'
import {
  endConsentedHolders,
  isConsentedHolder,
  processesUnder,
  processLabel
} from './workspace-copy-processes'
import { planWorkspaceCopyRemoval, type RemovalPlan } from './workspace-copy-removal-preview'
import { resolveCopySource } from './workspace-copy-source'
import { renameFileWithWindowsRetryAsync } from '../../windows-retry-file-operations'
import type {
  WorkspaceCopyRemovalOptions,
  WorkspaceCopyRemovalPreview,
  WorkspaceCopyRemovalResult
} from './workspace-copy-types'

export const REMOVING_PREFIX = '.removing-'
// ~5 s: the copy's terminals and agent sessions were just stopped, and Windows frees their folder only as they exit.
const MOVE_ASIDE_ATTEMPTS = 15

/** Why removal would refuse with these options, or null; callers check it before tearing anything down. */
export function copyRemovalRefusal(
  plan: WorkspaceCopyRemovalPreview,
  options: WorkspaceCopyRemovalOptions
): string | null {
  if (plan.blockers.openFiles && !options.revertOpenFiles) {
    return `${plan.openFiles.count} file(s) are open in ${plan.client}. Shelve or revert them first, or choose to revert them (their edits in the copy are lost).`
  }
  if (plan.blockers.shelves && !options.deleteShelves) {
    const shelved = plan.pendingChanges.filter((c) => c.shelvedFiles > 0).map((c) => c.change)
    return `Changelist(s) ${shelved.join(', ')} in ${plan.client} hold shelved files. Unshelve what you need, then choose to delete the shelves.`
  }
  const closeYourself = (plan.holders ?? []).filter((holder) => holder.canEnd === false)
  if (closeYourself.length > 0) {
    return `${closeYourself.map(processLabel).join(', ')} ha${closeYourself.length === 1 ? 's' : 've'} ${plan.copyRoot} open, and Orca will not end ${closeYourself.length === 1 ? 'it' : 'them'}. Close ${closeYourself.length === 1 ? 'that window' : 'those windows'} yourself and check again.`
  }
  // Why per process: consent covers the programs the user was shown, not ones opened since.
  const unconsented = (plan.holders ?? []).filter(
    (holder) => !isConsentedHolder(holder, options.endHolders)
  )
  if (unconsented.length > 0) {
    return `${unconsented.map(processLabel).join(', ')} still ha${unconsented.length === 1 ? 's' : 've'} ${plan.copyRoot} open. Close ${unconsented.length === 1 ? 'it' : 'them'} and check again, or choose to end ${unconsented.length === 1 ? 'it' : 'them'}.`
  }
  return null
}

/**
 * Moves the folder aside first: Windows refuses to rename a folder a program has files open in, so a
 * held copy is refused before Perforce is touched, and a Perforce failure can put the folder back.
 */
async function moveFolderAside(host: WorkspaceCopyHost, plan: RemovalPlan): Promise<string | null> {
  if (!plan.folderExists) {
    return null
  }
  const aside = join(
    plan.names.copiesDir,
    `${REMOVING_PREFIX}${plan.name}-${randomBytes(4).toString('hex')}`
  )
  try {
    await renameFileWithWindowsRetryAsync(plan.copyRoot, aside, () => true, MOVE_ASIDE_ATTEMPTS)
    return aside
  } catch (error) {
    // Orca's own terminals were stopped before this; any still holding the folder are named too.
    const holders = await processesUnder(host, plan.copyRoot, { includeOrca: true })
    const named =
      holders.length > 0 ? ` Still open in: ${holders.map(processLabel).join(', ')}.` : ''
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    throw new WorkspaceCopyError(
      'refused',
      `Windows would not move ${plan.copyRoot} (${code || 'in use'}); a program has files open in it.${named || ' Look for an editor, Unity, a terminal or an Explorer window open there.'} Close it and try again. Nothing was changed.`
    )
  }
}

async function cleanUpPerforce(
  host: WorkspaceCopyHost,
  plan: RemovalPlan,
  options: WorkspaceCopyRemovalOptions
): Promise<{ deletedChanges: number[]; deletedShelves: number[] }> {
  const { client } = plan
  const cwd = plan.source.root
  const deletedChanges: number[] = []
  const deletedShelves: number[] = []
  if (plan.openFiles.count > 0) {
    // -k keeps the files on disk; they go with the folder.
    await p4OrThrow(host, ['-c', client, 'revert', '-k', `//${client}/...`], cwd)
  }
  for (const change of plan.pendingChanges) {
    if (change.shelvedFiles > 0) {
      if (!options.deleteShelves) {
        continue
      }
      await p4OrThrow(host, ['-c', client, 'shelve', '-d', '-c', String(change.change)], cwd)
      deletedShelves.push(change.change)
    }
    await p4OrThrow(host, ['-c', client, 'change', '-d', String(change.change)], cwd)
    deletedChanges.push(change.change)
  }
  await p4OrThrow(host, ['client', '-d', client], cwd)
  return { deletedChanges, deletedShelves }
}

/**
 * Removes a copy: reverts (with `revertOpenFiles`) and deletes its pending changelists and shelves
 * (with `deleteShelves`), deletes its client, its folder, its marker, and its own stream when nothing
 * was submitted to it.
 */
export async function removeWorkspaceCopy(
  host: WorkspaceCopyHost,
  dir: string,
  name: string,
  options: WorkspaceCopyRemovalOptions = {},
  completion: { awaitFolderDeletion?: boolean } = {}
): Promise<WorkspaceCopyRemovalResult> {
  assertCopyName(name)
  const source = await resolveCopySource(host, dir)
  return withSourceLock(source.root, async () => {
    // Re-read now: the confirmation may be minutes old.
    const plan = await planWorkspaceCopyRemoval(host, source, name)
    const refusal = copyRemovalRefusal(plan, options)
    if (refusal) {
      throw new WorkspaceCopyError('refused', refusal)
    }
    // Why: the Source Control panel's scan runs inside the copy and would keep it open.
    const releaseScans = await holdWorkspaceScansUnder(plan.copyRoot)
    try {
      return await removeHeldCopy(host, plan, options, completion)
    } finally {
      releaseScans()
    }
  })
}

async function removeHeldCopy(
  host: WorkspaceCopyHost,
  plan: RemovalPlan,
  options: WorkspaceCopyRemovalOptions,
  completion: { awaitFolderDeletion?: boolean }
): Promise<WorkspaceCopyRemovalResult> {
  if (options.endHolders?.length) {
    await endConsentedHolders(host, plan.copyRoot, options.endHolders)
  }
  const aside = await moveFolderAside(host, plan)
  let perforce: { deletedChanges: number[]; deletedShelves: number[] } = {
    deletedChanges: [],
    deletedShelves: []
  }
  if (plan.clientExists) {
    try {
      perforce = await cleanUpPerforce(host, plan, options)
    } catch (error) {
      const restored = aside
        ? await rename(aside, plan.copyRoot).then(
            () => true,
            () => false
          )
        : true
      const where = restored ? 'The folder was left in place.' : `The folder is at ${aside}.`
      const message = error instanceof Error ? error.message : String(error)
      throw new WorkspaceCopyError('perforce', `${message} ${where}`)
    }
  }
  await rm(plan.markerPath, { force: true })
  const { streamDeleted, note } = await disposeChildStream(host, plan)
  if (aside) {
    const deletion = host.removeTree(aside)
    if (completion.awaitFolderDeletion) {
      await deletion
    } else {
      // Leftovers are retried by the next listing.
      deletion.catch(() => {})
    }
  }
  return {
    name: plan.name,
    client: plan.client,
    clientDeleted: plan.clientExists,
    folderDeleted: aside !== null,
    revertedFiles: plan.openFiles.count,
    deletedChanges: perforce.deletedChanges,
    deletedShelves: perforce.deletedShelves,
    streamDeleted,
    note
  }
}

async function disposeChildStream(
  host: WorkspaceCopyHost,
  plan: RemovalPlan
): Promise<{ streamDeleted: boolean; note: string | null }> {
  const child = plan.childStream
  if (!child) {
    return { streamDeleted: false, note: null }
  }
  if (child.submittedChanges === 0) {
    // Why a note: the client and folder are already gone, and deleting streams can be admin-only.
    const deleted = await host.p4(['stream', '-d', child.stream], { cwd: plan.source.root })
    return deleted.code === 0
      ? { streamDeleted: true, note: null }
      : {
          streamDeleted: false,
          note: `Could not delete the copy's stream ${child.stream}: ${deleted.stderr.trim() || deleted.stdout.trim()}`
        }
  }
  return {
    streamDeleted: false,
    note: `Kept ${child.stream} because it has submitted changes. To bring them into ${child.parent ?? 'its parent'}, run p4 copy -S ${child.stream} from a workspace on that stream, review and submit; delete the stream afterwards.`
  }
}
