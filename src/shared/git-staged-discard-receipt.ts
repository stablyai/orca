export type GitStagedDiscardReceipt = {
  operationId: string
  state: 'pending' | 'succeeded' | 'failed'
  mutation: 'none' | 'complete' | 'possible' | 'partial'
  affectedPaths: string[]
  completedPaths: string[]
  uncertainPaths: string[]
  remainingPaths: string[]
  error?: string
}

const OPERATION_ID_SEPARATOR = ':'

export function createGitStagedDiscardOperationId(now = Date.now()): string {
  return `${now}${OPERATION_ID_SEPARATOR}${globalThis.crypto.randomUUID()}`
}

export function gitStagedDiscardOperationTimestamp(operationId: string): number | null {
  const separator = operationId.indexOf(OPERATION_ID_SEPARATOR)
  if (separator < 1) {
    return null
  }
  const timestamp = Number(operationId.slice(0, separator))
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null
}

export function pendingGitStagedDiscardReceipt(
  operationId: string,
  affectedPaths: readonly string[]
): GitStagedDiscardReceipt {
  return {
    operationId,
    state: 'pending',
    mutation: 'possible',
    affectedPaths: [...affectedPaths],
    completedPaths: [],
    uncertainPaths: [...affectedPaths],
    remainingPaths: []
  }
}

export function failedGitStagedDiscardReceipt(
  operationId: string,
  affectedPaths: readonly string[],
  error: unknown
): GitStagedDiscardReceipt {
  return {
    operationId,
    state: 'failed',
    mutation: 'none',
    affectedPaths: [...affectedPaths],
    completedPaths: [],
    uncertainPaths: [],
    remainingPaths: [...affectedPaths],
    error: describeGitStagedDiscardError(error)
  }
}

export async function runGitStagedDiscardBatches(
  operationId: string,
  pathspecs: readonly string[],
  batchSize: number,
  runBatch: (paths: readonly string[]) => Promise<void>
): Promise<GitStagedDiscardReceipt> {
  const completedPaths: string[] = []
  for (let index = 0; index < pathspecs.length; index += batchSize) {
    const batch = pathspecs.slice(index, index + batchSize)
    try {
      await runBatch(batch)
      completedPaths.push(...batch)
    } catch (error) {
      return {
        operationId,
        state: 'failed',
        mutation: completedPaths.length > 0 ? 'partial' : 'possible',
        affectedPaths: [...pathspecs],
        completedPaths,
        uncertainPaths: [...batch],
        remainingPaths: pathspecs.slice(index + batch.length),
        error: describeGitStagedDiscardError(error)
      }
    }
  }
  return {
    operationId,
    state: 'succeeded',
    mutation: pathspecs.length > 0 ? 'complete' : 'none',
    affectedPaths: [...pathspecs],
    completedPaths,
    uncertainPaths: [],
    remainingPaths: []
  }
}

export function projectGitStagedDiscardReceiptPaths(
  receipt: GitStagedDiscardReceipt,
  requestedPaths: readonly string[]
): GitStagedDiscardReceipt {
  if (sameUniquePathSet(receipt.affectedPaths, requestedPaths)) {
    return receipt
  }
  if (receipt.state === 'succeeded') {
    return {
      ...receipt,
      affectedPaths: [...requestedPaths],
      completedPaths: [...requestedPaths]
    }
  }
  return {
    ...receipt,
    mutation: 'possible',
    affectedPaths: [...requestedPaths],
    completedPaths: [],
    uncertainPaths: [...requestedPaths],
    remainingPaths: []
  }
}

export function assertGitStagedDiscardReceipt(
  value: unknown,
  expectedOperationId?: string,
  expectedAffectedPaths?: readonly string[]
): GitStagedDiscardReceipt {
  if (
    !isGitStagedDiscardReceipt(value) ||
    (expectedOperationId !== undefined && value.operationId !== expectedOperationId) ||
    (expectedAffectedPaths !== undefined &&
      !sameUniquePathSet(value.affectedPaths, expectedAffectedPaths)) ||
    !hasExactPathPartition(value)
  ) {
    throw new Error('The Git owner returned an invalid staged discard receipt')
  }
  return value
}

export async function awaitTerminalGitStagedDiscardReceipt(
  initialReceipt: GitStagedDiscardReceipt,
  expectedOperationId: string,
  expectedAffectedPaths: readonly string[],
  getReceipt: () => Promise<unknown>,
  wait?: () => Promise<void>,
  signal?: AbortSignal
): Promise<GitStagedDiscardReceipt> {
  throwIfAborted(signal)
  let receipt = assertGitStagedDiscardReceipt(
    initialReceipt,
    expectedOperationId,
    expectedAffectedPaths
  )
  let delayMs = 250
  while (receipt.state === 'pending') {
    await abortableGitStagedDiscardPromise(wait ? wait() : waitForReceiptPoll(delayMs), signal)
    delayMs = Math.min(delayMs * 2, 5_000)
    let next: unknown
    try {
      next = await abortableGitStagedDiscardPromise(getReceipt(), signal)
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw error
      }
      continue
    }
    if (next !== null) {
      receipt = assertGitStagedDiscardReceipt(next, expectedOperationId, expectedAffectedPaths)
    }
  }
  return receipt
}

export function throwIfGitStagedDiscardFailed(receipt: GitStagedDiscardReceipt): void {
  if (receipt.state !== 'succeeded') {
    throw new GitStagedDiscardReceiptError(receipt)
  }
}

export class GitStagedDiscardReceiptError extends Error {
  constructor(readonly receipt: GitStagedDiscardReceipt) {
    super(receipt.error ?? 'Staged discard completion is still unknown')
    this.name = 'GitStagedDiscardReceiptError'
  }
}

function describeGitStagedDiscardError(error: unknown): string {
  return error instanceof Error ? error.message : 'Staged discard failed'
}

function waitForReceiptPoll(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

export function abortableGitStagedDiscardPromise<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return promise
  }
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(createAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

function createAbortError(): Error {
  const error = new Error('Staged discard receipt polling was canceled')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function sameUniquePathSet(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  if (actualSet.size !== actual.length || expectedSet.size !== expected.length) {
    return false
  }
  return (
    actualSet.size === expectedSet.size && [...actualSet].every((path) => expectedSet.has(path))
  )
}

function hasExactPathPartition(receipt: GitStagedDiscardReceipt): boolean {
  const partitions = [receipt.completedPaths, receipt.uncertainPaths, receipt.remainingPaths]
  const combined = partitions.flat()
  if (!sameUniquePathSet(combined, receipt.affectedPaths)) {
    return false
  }
  if (receipt.state === 'pending') {
    return (
      receipt.mutation === 'possible' &&
      receipt.completedPaths.length === 0 &&
      receipt.remainingPaths.length === 0 &&
      sameUniquePathSet(receipt.uncertainPaths, receipt.affectedPaths)
    )
  }
  if (receipt.state === 'succeeded') {
    return (
      receipt.uncertainPaths.length === 0 &&
      receipt.remainingPaths.length === 0 &&
      sameUniquePathSet(receipt.completedPaths, receipt.affectedPaths) &&
      receipt.mutation === (receipt.affectedPaths.length === 0 ? 'none' : 'complete')
    )
  }
  if (receipt.mutation === 'none') {
    return (
      receipt.completedPaths.length === 0 &&
      receipt.uncertainPaths.length === 0 &&
      sameUniquePathSet(receipt.remainingPaths, receipt.affectedPaths)
    )
  }
  if (receipt.mutation === 'partial') {
    return receipt.completedPaths.length > 0
  }
  return receipt.mutation === 'possible' && receipt.uncertainPaths.length > 0
}

function isGitStagedDiscardReceipt(value: unknown): value is GitStagedDiscardReceipt {
  if (!value || typeof value !== 'object') {
    return false
  }
  const receipt = value as Partial<GitStagedDiscardReceipt>
  const stringArrays = [
    receipt.affectedPaths,
    receipt.completedPaths,
    receipt.uncertainPaths,
    receipt.remainingPaths
  ]
  return (
    typeof receipt.operationId === 'string' &&
    ['pending', 'succeeded', 'failed'].includes(receipt.state ?? '') &&
    ['none', 'complete', 'possible', 'partial'].includes(receipt.mutation ?? '') &&
    stringArrays.every(
      (paths) => Array.isArray(paths) && paths.every((filePath) => typeof filePath === 'string')
    ) &&
    (receipt.error === undefined || typeof receipt.error === 'string')
  )
}
