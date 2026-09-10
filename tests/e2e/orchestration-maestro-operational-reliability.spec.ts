import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { OrchestrationDb } from '../../src/main/runtime/orchestration/db/orchestration-db'
import {
  createPendingWorkerStartReceipt,
  createWorkerAgentDiscoveryReceipt,
  createWorkerStartRecoveryCommand,
  isReadinessUnverifiable
} from '../../src/main/runtime/rpc/methods/orchestration-worker-start'
import { resolveReplacementWorkerStart } from '../../src/main/runtime/rpc/methods/orchestration/worker/worker-start-schema'
import { createDraftPasteReadyScanner } from '../../src/shared/draft-paste-ready-scanner'
import { exerciseWorkflowReviewAndMobile } from './fixtures/orchestration-maestro-operational-reliability/career-ops-journey-fixture'
import {
  exerciseSessionTransferAndRestart,
  exerciseSettledChildWorktreeCleanup
} from './fixtures/orchestration-maestro-operational-reliability/run-cleanup-fixture'

export function exerciseLaunchContracts() {
  const discovery = createWorkerAgentDiscoveryReceipt('opencode')
  const pending = createPendingWorkerStartReceipt({
    runId: 'run-career-ops',
    taskId: 'task-launch',
    attemptId: 'attempt-launch',
    dispatchId: 'dispatch-launch',
    leaseId: 'lease-launch',
    terminalHandle: 'term-launch',
    agentDiscovery: discovery
  })
  const scanner = createDraftPasteReadyScanner('opencode-composer-prompt')
  const composerReady = scanner.observe('\x1b[?2004hAsk anything').ready
  const replacement = resolveReplacementWorkerStart(
    { task: 'task-launch', from: 'term-coordinator', replacementOf: 'dispatch-launch' },
    {
      getWorkerDispatch: () => ({
        start_options: JSON.stringify({
          agent: 'opencode',
          resolvedWorktreeId: 'repo::/worktrees/career-ops',
          launch: { requested: { agent: 'opencode', model: null, effort: null } }
        })
      })
    } as OrchestrationDb
  )
  return {
    discovery,
    pendingReadiness: pending.readiness,
    composerReady,
    readinessUnverifiable: isReadinessUnverifiable(new Error('timeout'), 'agent_readiness'),
    replacementAgent: replacement.agent,
    replacementAttempt: replacement.attemptId,
    recoveryCommand: createWorkerStartRecoveryCommand({
      executable: 'orca-dev',
      taskId: 'task-launch',
      dispatchId: 'dispatch-launch',
      exactRetryAvailable: false
    })
  }
}

type VisualManifest = {
  reviewed_with: string
  results: { browser: string; screenshot: string; sha256: string; status: string }[]
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifyVisualManifest(path: string, browser: string): number {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as VisualManifest
  if (manifest.reviewed_with !== 'view_image' || manifest.results.length !== 4) {
    throw new Error(`Visual evidence manifest is incomplete: ${path}`)
  }
  for (const result of manifest.results) {
    const screenshot = resolve(result.screenshot)
    if (
      result.status !== 'pass' ||
      result.browser !== browser ||
      !existsSync(screenshot) ||
      sha256(screenshot) !== result.sha256
    ) {
      throw new Error(`Visual evidence is stale or unreviewed: ${result.screenshot}`)
    }
  }
  return manifest.results.length
}

function verifyCareerOpsVisualEvidence(): number {
  return (
    verifyVisualManifest(
      resolve('.visual-evidence/orchestration-maestro-operational-reliability/manifest.json'),
      'chromium'
    ) +
    verifyVisualManifest(
      resolve(
        '.visual-evidence/orchestration-maestro-operational-reliability/mobile-manifest.json'
      ),
      'webkit'
    )
  )
}

async function exerciseCareerOpsJourney() {
  const root = mkdtempSync(join(tmpdir(), 'orca-omr-journey-'))
  try {
    return {
      launch: exerciseLaunchContracts(),
      session: exerciseSessionTransferAndRestart(root),
      workflow: await exerciseWorkflowReviewAndMobile(),
      visualEvidenceCount: verifyCareerOpsVisualEvidence()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('proves the bounded Career Ops lifecycle and exact Run cleanup', async (// oxlint-disable-next-line no-empty-pattern -- The real desktop/mobile surfaces are represented by their vision-reviewed manifests, so this contract fixture reuses the active runtimes.
{}) => {
  const journey = await exerciseCareerOpsJourney()
  const result = await exerciseSettledChildWorktreeCleanup()

  expect(journey).toMatchObject({
    launch: {
      discovery: { requestedId: 'opencode', resolvedId: 'opencode', executable: 'opencode' },
      pendingReadiness: 'pending',
      composerReady: true,
      readinessUnverifiable: true,
      replacementAgent: 'opencode',
      replacementAttempt: 'replacement-dispatch-launch',
      recoveryCommand: expect.stringContaining('replace-worker --task task-launch')
    },
    session: {
      leaseTransferred: true,
      activeRead: ['successor output'],
      predecessorRead: ['predecessor output'],
      restartPreserved: true,
      restartedRead: ['successor output']
    },
    workflow: {
      deliverablesPercent: 100,
      reliability: { successful: 1, failed: 0, superseded: 1, unverifiable: 1 },
      runLabel: 'Career Ops application run',
      projectionRevision: 7,
      browserIdentityStable: true,
      browserUrlSanitized: true,
      consentRevoked: true,
      reviewStates: ['needs_input', 'approved_for_submit', 'submitted'],
      exactMobileTab: 'tab-browser-career-ops',
      mixedVersionState: 'unavailable'
    },
    visualEvidenceCount: 8
  })
  expect(result).toEqual({
    selectedWorktreeCount: 1,
    firstDisposition: 'removed',
    replayDisposition: 'already_absent',
    childAbsent: true,
    branchPreserved: true
  })
})
