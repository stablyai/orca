import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'

test.describe.configure({ mode: 'serial' })

test('an archived Codex rollout stays inactive across two Orca launches', async (// oxlint-disable-next-line no-empty-pattern -- This lifecycle test owns both disposable Electron launches.
{}, testInfo) => {
  const session = createRestartSession(testInfo)
  const threadId = randomUUID()
  const fileName = `rollout-2026-08-12T00-00-00-${threadId}.jsonl`
  const managedPath = path.join(
    session.userDataDir,
    'codex-runtime-home',
    'home',
    'sessions',
    '2026',
    '08',
    '12',
    fileName
  )
  const systemCodexHome = path.join(session.userDataDir, 'home', '.codex')
  const activePath = path.join(systemCodexHome, 'sessions', '2026', '08', '12', fileName)
  const archivedPath = path.join(systemCodexHome, 'archived_sessions', fileName)
  const stateDir = path.join(session.userDataDir, 'codex-session-backfill')
  const auditPath = path.join(stateDir, 'audit.jsonl')
  const markerPath = path.join(stateDir, 'backfill-complete.json')
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  mkdirSync(path.dirname(managedPath), { recursive: true })
  mkdirSync(path.dirname(archivedPath), { recursive: true })
  writeFileSync(
    managedPath,
    `${JSON.stringify({
      timestamp: '2026-08-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd: session.userDataDir }
    })}\n`
  )
  linkSync(managedPath, archivedPath)

  try {
    firstApp = (await session.launch()).app
    await expect.poll(() => countRunSummaries(auditPath), { timeout: 30_000 }).toBeGreaterThan(0)
    expect(existsSync(activePath)).toBe(false)
    expect(existsSync(archivedPath)).toBe(true)
    await session.close(firstApp)
    firstApp = null

    // Force the second launch to execute a fresh reconciliation pass against
    // the same profile instead of accepting the first launch's completion marker.
    rmSync(markerPath, { force: true })
    const secondPassNotBefore = Date.now()
    secondApp = (await session.launch()).app
    await expect
      .poll(() => readBackfillMarker(markerPath)?.completedAt ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(secondPassNotBefore)
    expect(readBackfillMarker(markerPath)?.summary).toMatchObject({
      scannedFiles: 1,
      skippedExistingFiles: 1,
      failedDirectories: 0,
      failedFiles: 0,
      failedHealAuditRecords: 0
    })
    expect(existsSync(activePath)).toBe(false)
    expect(existsSync(archivedPath)).toBe(true)
  } finally {
    if (firstApp) {
      await session.close(firstApp)
    }
    if (secondApp) {
      await session.close(secondApp)
    }
    await session.dispose()
  }
})

function countRunSummaries(auditPath: string): number {
  if (!existsSync(auditPath)) {
    return 0
  }
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"action":"run-summary"')).length
}

function readBackfillMarker(markerPath: string): {
  completedAt: number
  summary: Record<string, number | boolean>
} | null {
  if (!existsSync(markerPath)) {
    return null
  }
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      completedAt?: unknown
      summary?: unknown
    }
    if (
      typeof marker.completedAt !== 'number' ||
      !marker.summary ||
      typeof marker.summary !== 'object' ||
      Array.isArray(marker.summary)
    ) {
      return null
    }
    return {
      completedAt: marker.completedAt,
      summary: marker.summary as Record<string, number | boolean>
    }
  } catch {
    return null
  }
}
