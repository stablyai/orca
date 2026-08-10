import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { GitStagedDiscardReceiptFileStorage } from './git-staged-discard-receipt-file-storage'
import { GitStagedDiscardReceiptLedger } from './git-staged-discard-receipt-ledger'
import {
  createGitStagedDiscardOperationId,
  pendingGitStagedDiscardReceipt,
  runGitStagedDiscardBatches
} from './git-staged-discard-receipt'

const cleanupPaths: string[] = []

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    rmSync(cleanupPath, { recursive: true, force: true })
  }
})

it('bounds 256 by 100-path durable receipts without whole-ledger rewrites', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-staged-discard-performance-'))
  cleanupPaths.push(root)
  const filePath = path.join(root, 'receipts.json')
  const storage = new GitStagedDiscardReceiptFileStorage(filePath)
  let now = 1_000_000
  const ledger = new GitStagedDiscardReceiptLedger({ storage, now: () => now })
  let lastOperationId = ''
  let lastPaths: string[] = []
  const heapBefore = process.memoryUsage().heapUsed
  const cpuBefore = process.cpuUsage()
  const startedAt = performance.now()

  for (let operationIndex = 0; operationIndex < 256; operationIndex += 1) {
    lastOperationId = createGitStagedDiscardOperationId(now++)
    lastPaths = Array.from(
      { length: 100 },
      (_, pathIndex) => `operation-${operationIndex}/${'nested-path-'.repeat(8)}${pathIndex}.txt`
    )
    await ledger.run(
      'repo',
      lastOperationId,
      lastPaths.join('\0'),
      pendingGitStagedDiscardReceipt(lastOperationId, lastPaths),
      async () => runGitStagedDiscardBatches(lastOperationId, lastPaths, 100, async () => {})
    )
  }

  const elapsedMs = performance.now() - startedAt
  const cpu = process.cpuUsage(cpuBefore)
  const cpuMicros = cpu.user + cpu.system
  const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore
  expect(statSync(filePath).size).toBeLessThanOrEqual(8 * 1024 * 1024)
  expect(elapsedMs).toBeLessThan(10_000)
  expect(cpuMicros).toBeLessThan(3_000_000)
  expect(retainedHeapBytes).toBeLessThan(32 * 1024 * 1024)

  const restarted = new GitStagedDiscardReceiptLedger({ storage, now: () => now })
  const duplicateMutation = vi.fn()
  await expect(
    restarted.run(
      'repo',
      lastOperationId,
      lastPaths.join('\0'),
      pendingGitStagedDiscardReceipt(lastOperationId, lastPaths),
      duplicateMutation
    )
  ).resolves.toMatchObject({ state: 'succeeded' })
  expect(duplicateMutation).not.toHaveBeenCalled()
}, 15_000)
