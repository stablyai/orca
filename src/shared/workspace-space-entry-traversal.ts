import type { WorkspaceSpaceItemKind } from './workspace-space-types'
import {
  collectWorkspaceSpaceDirectoryEntries,
  createWorkspaceSpaceScanBudget,
  WorkspaceSpaceScanCapacityError,
  type WorkspaceSpaceScanBudget,
  type WorkspaceSpaceScanLimits
} from './workspace-space-scan-budget'

type ScannableWorkspaceSpaceItemKind = Exclude<WorkspaceSpaceItemKind, 'other'>

export type WorkspaceSpaceEntryScan = {
  name: string
  path: string
  kind: ScannableWorkspaceSpaceItemKind
  sizeBytes: number
  skippedEntryCount: number
  children?: WorkspaceSpaceEntryScan[]
}

type WorkspaceSpaceEntryIdentity = {
  kind: ScannableWorkspaceSpaceItemKind
  sizeBytes: number
}

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

type ParentSlot<TEntry> = {
  frame: DirectoryFrame<TEntry>
  index: number
}

type DirectoryFrame<TEntry> = {
  result: WorkspaceSpaceEntryScan
  entries: readonly TEntry[]
  nextIndex: number
  remainingChildren: number
  childResults?: (WorkspaceSpaceEntryScan | null | undefined)[]
  parentSlot?: ParentSlot<TEntry>
}

type EntryJob<TEntry> = {
  frame: DirectoryFrame<TEntry>
  index: number
  entry: TEntry
  name: string
  path: string
}

function createEntryScan(
  path: string,
  name: string,
  identity: WorkspaceSpaceEntryIdentity
): WorkspaceSpaceEntryScan {
  return {
    name,
    path,
    kind: identity.kind,
    sizeBytes: identity.sizeBytes,
    skippedEntryCount: 0
  }
}

async function readDirectoryOrNull<TEntry>(
  path: string,
  options: WorkspaceSpaceEntryTraversalOptions<TEntry>,
  budget: WorkspaceSpaceScanBudget
): Promise<readonly TEntry[] | null> {
  try {
    const directory = await options.readDirectory(path)
    const entries = await collectWorkspaceSpaceDirectoryEntries(
      directory,
      path,
      options.entryName,
      budget,
      options.checkCancelled
    )
    options.checkCancelled()
    return entries
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

  const rootEntries = await readDirectoryOrNull(options.rootPath, options, budget)
  if (rootEntries === null) {
    root.skippedEntryCount = 1
    return root
  }
  if (rootEntries.length === 0) {
    root.children = []
    return root
  }

  const rootFrame: DirectoryFrame<TEntry> = {
    result: root,
    entries: rootEntries,
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

  const takeAvailableJob = (): EntryJob<TEntry> | null => {
    while (availableFrames.length > 0) {
      const frame = availableFrames.at(-1)!
      if (frame.nextIndex >= frame.entries.length) {
        availableFrames.pop()
        continue
      }
      const index = frame.nextIndex
      frame.nextIndex += 1
      if (frame.nextIndex >= frame.entries.length) {
        availableFrames.pop()
      }
      const entry = frame.entries[index]
      const name = options.entryName(entry)
      return {
        frame,
        index,
        entry,
        name,
        path: options.joinPath(frame.result.path, name)
      }
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
    entries: readonly TEntry[]
  ): void => {
    if (entries.length === 0) {
      completeChild(job.frame, job.index, result)
      return
    }
    outstandingEntries += entries.length
    availableFrames.push({
      result,
      entries,
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
    const entries = await readDirectoryOrNull(job.path, options, budget)
    if (entries === null) {
      result.skippedEntryCount = 1
      completeChild(job.frame, job.index, result)
      return
    }
    expandDirectory(job, result, entries)
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
