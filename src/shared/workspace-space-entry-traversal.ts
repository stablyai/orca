import {
  createEntryScan,
  type DirectoryFrame,
  type EntryJob,
  type WorkspaceSpaceEntryIdentity,
  type WorkspaceSpaceEntryScan
} from './workspace-space-directory-frame'
import {
  collectWorkspaceSpaceDirectoryEntries,
  createWorkspaceSpaceScanBudget,
  releaseWorkspaceSpaceScanEntries,
  WorkspaceSpaceScanCapacityError,
  type WorkspaceSpaceDirectoryAdmission,
  type WorkspaceSpaceScanBudget,
  type WorkspaceSpaceScanLimits
} from './workspace-space-scan-budget'

export type { WorkspaceSpaceEntryScan } from './workspace-space-directory-frame'

type WorkspaceSpaceEntryTraversalOptions<TEntry> = {
  rootPath: string
  rootName: string
  concurrency: number
  signal?: AbortSignal
  entryName: (entry: TEntry) => string
  joinPath: (parent: string, child: string) => string
  classifyEntry: (path: string, sourceEntry: TEntry | null) => Promise<WorkspaceSpaceEntryIdentity>
  readDirectory: (path: string) => Promise<AsyncIterable<TEntry> | Iterable<TEntry>>
  checkCancelled: () => void
  createCancellationError: () => Error
  isCancellationError: (error: unknown) => boolean
  limits?: Partial<WorkspaceSpaceScanLimits>
}

async function readDirectoryOrNull<TEntry>(
  path: string,
  options: WorkspaceSpaceEntryTraversalOptions<TEntry>,
  budget: WorkspaceSpaceScanBudget
): Promise<WorkspaceSpaceDirectoryAdmission<TEntry> | null> {
  try {
    const directory = await options.readDirectory(path)
    const admission = await collectWorkspaceSpaceDirectoryEntries(
      directory,
      path,
      options.entryName,
      budget,
      options.checkCancelled
    )
    options.checkCancelled()
    return admission
  } catch (error) {
    if (options.isCancellationError(error) || error instanceof WorkspaceSpaceScanCapacityError) {
      throw error
    }
    return null
  }
}

/**
 * Scans one directory tree with a fixed worker pool. Directory frames retain
 * the source arrays returned by readdir, but never allocate one promise or
 * queued closure per entry; only the configured workers own live entry jobs.
 */
export async function scanWorkspaceSpaceEntryTree<TEntry>(
  options: WorkspaceSpaceEntryTraversalOptions<TEntry>
): Promise<WorkspaceSpaceEntryScan> {
  const budget = createWorkspaceSpaceScanBudget(options.limits)
  options.checkCancelled()
  const rootIdentity = await options.classifyEntry(options.rootPath, null)
  options.checkCancelled()
  const root = createEntryScan(options.rootPath, options.rootName, rootIdentity)
  if (root.kind !== 'directory') {
    return root
  }

  const rootAdmission = await readDirectoryOrNull(options.rootPath, options, budget)
  if (rootAdmission === null) {
    root.skippedEntryCount = 1
    return root
  }
  const rootEntries = rootAdmission.entries
  if (rootEntries.length === 0) {
    root.children = []
    return root
  }

  const rootFrame: DirectoryFrame<TEntry> = {
    result: root,
    entries: rootEntries,
    retainedBytes: rootAdmission.retainedBytes,
    retired: false,
    nextIndex: 0,
    remainingChildren: rootEntries.length,
    childResults: Array.from({ length: rootEntries.length }, () => undefined)
  }
  const availableFrames: DirectoryFrame<TEntry>[] = [rootFrame]
  const waiters = new Set<() => void>()
  let outstandingEntries = rootEntries.length
  let fatalError: unknown = null

  const wakeWorkers = (): void => {
    for (const wake of waiters) {
      wake()
    }
  }
  const fail = (error: unknown): void => {
    fatalError ??= error
    wakeWorkers()
  }
  const onAbort = (): void => fail(options.createCancellationError())
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) {
    onAbort()
  }

  // Why: once every entry is dispatched the listing is dead weight, so drop it
  // and hand its charge back before the walk descends any further.
  const retireFrame = (frame: DirectoryFrame<TEntry>): void => {
    if (frame.retired) {
      return
    }
    frame.retired = true
    releaseWorkspaceSpaceScanEntries(budget, frame.retainedBytes)
    frame.entries = []
    frame.retainedBytes = 0
  }

  const takeAvailableJob = (): EntryJob<TEntry> | null => {
    while (availableFrames.length > 0) {
      const frame = availableFrames.at(-1)!
      if (frame.nextIndex >= frame.entries.length) {
        availableFrames.pop()
        retireFrame(frame)
        continue
      }
      const index = frame.nextIndex
      frame.nextIndex += 1
      const entry = frame.entries[index]
      const name = options.entryName(entry)
      const path = options.joinPath(frame.result.path, name)
      if (frame.nextIndex >= frame.entries.length) {
        availableFrames.pop()
        retireFrame(frame)
      }
      return { frame, index, entry, name, path }
    }
    return null
  }

  const waitForJob = async (): Promise<EntryJob<TEntry> | null> => {
    while (fatalError === null) {
      options.checkCancelled()
      const job = takeAvailableJob()
      if (job) {
        return job
      }
      if (outstandingEntries === 0) {
        return null
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          waiters.delete(wake)
          resolve()
        }
        waiters.add(wake)
      })
    }
    return null
  }

  const completeChild = (
    initialFrame: DirectoryFrame<TEntry>,
    initialIndex: number,
    initialResult: WorkspaceSpaceEntryScan | null
  ): void => {
    let frame = initialFrame
    let index = initialIndex
    let result = initialResult
    while (true) {
      if (frame.childResults) {
        frame.childResults[index] = result
      }
      if (result) {
        frame.result.sizeBytes += result.sizeBytes
        frame.result.skippedEntryCount += result.skippedEntryCount
      } else {
        frame.result.skippedEntryCount += 1
      }
      frame.remainingChildren -= 1
      outstandingEntries -= 1
      if (frame.remainingChildren > 0) {
        break
      }
      if (frame.childResults) {
        frame.result.children = frame.childResults.filter(
          (child): child is WorkspaceSpaceEntryScan => child != null
        )
      }
      if (!frame.parentSlot) {
        break
      }
      result = frame.result
      index = frame.parentSlot.index
      frame = frame.parentSlot.frame
    }
    wakeWorkers()
  }

  const expandDirectory = (
    job: EntryJob<TEntry>,
    result: WorkspaceSpaceEntryScan,
    admission: WorkspaceSpaceDirectoryAdmission<TEntry>
  ): void => {
    const entries = admission.entries
    if (entries.length === 0) {
      completeChild(job.frame, job.index, result)
      return
    }
    outstandingEntries += entries.length
    availableFrames.push({
      result,
      entries,
      retainedBytes: admission.retainedBytes,
      retired: false,
      nextIndex: 0,
      remainingChildren: entries.length,
      parentSlot: { frame: job.frame, index: job.index }
    })
    wakeWorkers()
  }

  const processJob = async (job: EntryJob<TEntry>): Promise<void> => {
    let identity: WorkspaceSpaceEntryIdentity
    try {
      identity = await options.classifyEntry(job.path, job.entry)
      options.checkCancelled()
    } catch (error) {
      if (options.isCancellationError(error)) {
        throw error
      }
      completeChild(job.frame, job.index, null)
      return
    }

    const result = createEntryScan(job.path, job.name, identity)
    if (result.kind !== 'directory') {
      completeChild(job.frame, job.index, result)
      return
    }
    const admission = await readDirectoryOrNull(job.path, options, budget)
    if (admission === null) {
      result.skippedEntryCount = 1
      completeChild(job.frame, job.index, result)
      return
    }
    expandDirectory(job, result, admission)
  }

  const worker = async (): Promise<void> => {
    while (fatalError === null) {
      let job: EntryJob<TEntry> | null
      try {
        job = await waitForJob()
      } catch (error) {
        fail(error)
        return
      }
      if (!job) {
        return
      }
      try {
        await processJob(job)
      } catch (error) {
        fail(error)
        return
      }
    }
  }

  const workerCount = Math.max(1, Math.floor(options.concurrency))
  try {
    await Promise.all(Array.from({ length: workerCount }, worker))
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    wakeWorkers()
  }
  if (fatalError !== null) {
    throw fatalError
  }
  return root
}
