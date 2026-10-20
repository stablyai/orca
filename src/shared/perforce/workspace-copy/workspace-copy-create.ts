import { mkdir } from 'node:fs/promises'
import {
  type CreatedParts,
  assertCopyBinding,
  assertNameFree,
  robocopyFailure,
  rollBack,
  spaceUsed
} from './workspace-copy-create-steps'
import { WorkspaceCopyError } from './workspace-copy-errors'
import {
  excludedFiles,
  excludedFolders,
  findUnityProjects,
  relativeTo,
  robocopyArguments,
  robocopyFailed
} from './workspace-copy-files'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { withSourceLock } from './workspace-copy-lock'
import { buildMarker, writeMarker } from './workspace-copy-marker'
import { assertCopyName, copyNamesFor, type WorkspaceCopyNames } from './workspace-copy-names'
import { haveRevisions, openedRecords, p4OrThrow } from './workspace-copy-p4'
import { unityProjectsOpenInEditor } from './workspace-copy-processes'
import { checkCopyReadiness, formatGb } from './workspace-copy-readiness'
import { rebindCopy, unityVersionControlBinding } from './workspace-copy-rebind'
import {
  alignToStream,
  repairChangedDuringCopy,
  restoreOpenedFiles,
  restoreTrackedInExcluded
} from './workspace-copy-restore'
import type { CopySource } from './workspace-copy-source'
import { createCopyClient, createCopyStream } from './workspace-copy-specs'
import { resolveStreamChoice, type ResolvedStreamChoice } from './workspace-copy-stream-choice'
import type {
  WorkspaceCopyCreateOptions,
  WorkspaceCopyCreateResult,
  WorkspaceCopyProgress
} from './workspace-copy-types'

type Progress = (progress: WorkspaceCopyProgress) => void

/**
 * Makes a copy-on-write copy of the stream workspace at `dir` beside it (`<root>.wt\<name>`), with
 * its own client adopting the copied files through `p4 flush`, so nothing is downloaded.
 */
export async function createWorkspaceCopy(
  host: WorkspaceCopyHost,
  dir: string,
  options: WorkspaceCopyCreateOptions,
  onProgress: Progress = () => {}
): Promise<WorkspaceCopyCreateResult> {
  assertCopyName(options.name)
  const started = Date.now()
  onProgress({
    phase: 'checking',
    message: 'Checking the workspace, the drive and Perforce'
  })
  const readiness = await checkCopyReadiness(host, dir, {
    minFreeBytes: options.minFreeBytes
  })
  const source = readiness.resolvedSource
  if (!readiness.ready || !source) {
    throw new WorkspaceCopyError('refused', readiness.problems.join(' '))
  }
  return withSourceLock(source.root, () =>
    createLocked(host, source, options, readiness.warnings, started, onProgress)
  )
}

async function createLocked(
  host: WorkspaceCopyHost,
  source: CopySource,
  options: WorkspaceCopyCreateOptions,
  warnings: string[],
  started: number,
  onProgress: Progress
): Promise<WorkspaceCopyCreateResult> {
  const names = copyNamesFor(source, options.name)
  await assertNameFree(host, names, source.root)
  const choice = await resolveStreamChoice(host, source, names, options.stream ?? { kind: 'child' })
  const sourceOpened = await openedRecords(host, source.client, source.root)
  const projects = await findUnityProjects(source.root)
  for (const project of await unityProjectsOpenInEditor(host, projects)) {
    warnings.push(
      `A Unity editor has ${project} open. If the copy's Library turns out damaged, remove the copy and make it again while the editor is idle.`
    )
  }
  const seconds: Record<string, number> = { checks: elapsed(started) }
  const created: CreatedParts = { folder: false, stream: null, client: false }
  try {
    await mkdir(names.copiesDir, { recursive: true })
    created.folder = true
    const freeBefore = await host.freeBytes(names.copiesDir)
    const haveBefore = await haveRevisions(host, source.client, source.root)
    let mark = Date.now()
    onProgress({
      phase: 'copying',
      message: `Copying ${source.root} to ${names.copyRoot}`
    })
    const excluded = excludedFolders(source.root, projects, options)
    const copy = await host.robocopy(
      robocopyArguments(source.root, names.copyRoot, excluded, excludedFiles(projects))
    )
    if (robocopyFailed(copy.code)) {
      throw new WorkspaceCopyError('copy', robocopyFailure(copy.code, copy.stdout))
    }
    const freeAfter = await host.freeBytes(names.copiesDir)
    seconds.copy = elapsed(mark)
    mark = Date.now()
    await createClientAndAdopt(host, source, names, choice, created, onProgress)
    seconds.perforce = elapsed(mark)
    mark = Date.now()
    onProgress({
      phase: 'restoring',
      message: 'Putting files you have open back to the depot version'
    })
    const tracked = await restoreTrackedInExcluded(host, source, names, excluded)
    const restored = await restoreOpenedFiles(host, source, names, sourceOpened, {
      removeAddsOnly: choice.align
    })
    let aligned: number | null = null
    if (choice.align) {
      onProgress({
        phase: 'aligning',
        message: `Fetching the files that differ on ${choice.stream}`
      })
      aligned = (await alignToStream(host, source, names, sourceOpened)).fetched
    }
    const changedDuringCopy = await repairChangedDuringCopy(host, source, names, haveBefore)
    if (changedDuringCopy > 0) {
      warnings.push(
        `${changedDuringCopy} file(s) changed in ${source.client} while the copy was made (a sync ran); they were put back to the copy's own revision.`
      )
    }
    onProgress({
      phase: 'rebinding',
      message: 'Pointing the copy at its own client'
    })
    const rewritten = await rebindCopy(source, names, projects)
    onProgress({
      phase: 'verifying',
      message: 'Checking the copy resolves its own client'
    })
    await assertCopyBinding(host, names)
    const binding = await unityVersionControlBinding(projects, names.client)
    const marker = buildMarker({
      source,
      names,
      stream: choice.stream,
      mode: choice.mode,
      unityVersionControlBinding: binding
    })
    await writeMarker(names.markerPath, marker)
    seconds.cleanup = elapsed(mark)
    seconds.total = elapsed(started)
    const space = spaceUsed(copy.stdout, freeBefore, freeAfter)
    if (space.cloned === false) {
      warnings.push(
        `The copy used ${formatGb(space.usedBytes)} of disk for ${formatGb(space.copiedBytes ?? 0)} of files: the drive did not block-clone it.`
      )
    }
    return {
      name: names.name,
      copyRoot: names.copyRoot,
      client: names.client,
      stream: choice.stream,
      mode: choice.mode,
      streamChoice: choice.reason,
      source: {
        client: source.client,
        root: source.root,
        stream: source.stream
      },
      markerPath: names.markerPath,
      unityProjects: projects.map((project) => relativeTo(source.root, project)),
      unityVersionControlBinding: binding,
      openFilesRestored: restored.restoredToHave,
      addsRemoved: restored.removedAdds,
      trackedInSkippedFolders: tracked,
      changedDuringCopy,
      alignedFiles: aligned,
      rewritten,
      space,
      warnings,
      seconds
    }
  } catch (error) {
    onProgress({
      phase: 'rolling-back',
      message: 'A step failed; removing what was created'
    })
    throw await rollBack(host, source, names, created, error)
  }
}

async function createClientAndAdopt(
  host: WorkspaceCopyHost,
  source: CopySource,
  names: WorkspaceCopyNames,
  choice: ResolvedStreamChoice,
  created: CreatedParts,
  onProgress: Progress
): Promise<void> {
  if (choice.createUnder) {
    onProgress({
      phase: 'creating-client',
      message: `Creating stream ${choice.stream} under ${choice.createUnder}`
    })
    await createCopyStream(host, source, choice.stream, choice.createUnder)
    created.stream = choice.stream
  }
  onProgress({
    phase: 'creating-client',
    message: `Creating client ${names.client} on ${choice.stream}`
  })
  await createCopyClient(host, source, names, choice.stream)
  created.client = true
  onProgress({
    phase: 'adopting',
    message: 'Recording the copied files in the new client (nothing is downloaded)'
  })
  // A same-stream copy takes the source's have-list; any other stream its head, after which
  // alignToStream fetches only the files that differ.
  const revision = choice.align ? '' : `@${source.client}`
  await p4OrThrow(
    host,
    ['-q', '-c', names.client, 'flush', `//${names.client}/...${revision}`],
    names.copyRoot
  )
}

function elapsed(since: number): number {
  return Math.round((Date.now() - since) / 100) / 10
}
