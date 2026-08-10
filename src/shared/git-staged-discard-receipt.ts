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

type ReceiptEntry = {
  fingerprint: string
  receipt: GitStagedDiscardReceipt
  promise: Promise<GitStagedDiscardReceipt>
}

const DEFAULT_MAX_RECEIPTS = 256

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

export function assertGitStagedDiscardReceipt(
  value: unknown,
  expectedOperationId?: string
): GitStagedDiscardReceipt {
  if (
    !isGitStagedDiscardReceipt(value) ||
    (expectedOperationId !== undefined && value.operationId !== expectedOperationId)
  ) {
    throw new Error('The Git owner returned an invalid staged discard receipt')
  }
  return value
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

export class GitStagedDiscardReceiptLedger {
  private readonly entries = new Map<string, ReceiptEntry>()

  constructor(private readonly maxReceipts = DEFAULT_MAX_RECEIPTS) {}

  run(
    scope: string,
    operationId: string,
    fingerprint: string,
    pending: GitStagedDiscardReceipt,
    operation: () => Promise<GitStagedDiscardReceipt>
  ): Promise<GitStagedDiscardReceipt> {
    const key = receiptKey(scope, operationId)
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error('Staged discard operation ID was reused'))
      }
      return existing.promise
    }
    this.ensureCapacity()
    const promise = operation().then(
      (receipt) => {
        const entry = this.entries.get(key)
        if (entry) {
          entry.receipt = receipt
        }
        return receipt
      },
      (error) => {
        const receipt = failedGitStagedDiscardReceipt(operationId, pending.affectedPaths, error)
        const entry = this.entries.get(key)
        if (entry) {
          entry.receipt = receipt
        }
        return receipt
      }
    )
    this.entries.set(key, { fingerprint, receipt: pending, promise })
    return promise
  }

  get(scope: string, operationId: string): GitStagedDiscardReceipt | null {
    return this.entries.get(receiptKey(scope, operationId))?.receipt ?? null
  }

  clear(): void {
    this.entries.clear()
  }

  private ensureCapacity(): void {
    if (this.entries.size < this.maxReceipts) {
      return
    }
    const settled = [...this.entries].find(([, entry]) => entry.receipt.state !== 'pending')
    if (!settled) {
      throw new Error('Too many staged discard operations are still pending')
    }
    this.entries.delete(settled[0])
  }
}

function receiptKey(scope: string, operationId: string): string {
  return `${scope}\0${operationId}`
}

function describeGitStagedDiscardError(error: unknown): string {
  return error instanceof Error ? error.message : 'Staged discard failed'
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
