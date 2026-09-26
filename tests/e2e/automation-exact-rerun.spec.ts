import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Automation, AutomationRun } from '../../src/shared/automations-types'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { waitForSessionReady } from './helpers/store'

const AUTOMATION_ID = 'exact-rerun-automation'
const AUTOMATION_NAME = 'Synthetic daily report'
const OLDER_RUN_ID = 'older-failed-run'
const OLDER_OCCURRENCE = Date.parse('2026-05-18T09:00:00Z')
const NEWER_OCCURRENCE = Date.parse('2026-05-20T09:00:00Z')

function failedRun(id: string, runNumber: number, scheduledFor: number): AutomationRun {
  return {
    id,
    automationId: AUTOMATION_ID,
    title: `${AUTOMATION_NAME} run ${runNumber}`,
    runNumber,
    scheduledFor,
    scheduledTimezone: 'UTC',
    status: 'dispatch_failed',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: `Synthetic failure for run ${runNumber}`,
    startedAt: scheduledFor,
    dispatchedAt: null,
    createdAt: scheduledFor
  }
}

test('Rerun keeps the selected older occurrence through repeated retries', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  const automation: Automation = {
    id: AUTOMATION_ID,
    name: AUTOMATION_NAME,
    prompt: 'Synthetic report; no billing or agent work should run.',
    precheck: null,
    agentId: 'codex',
    projectId: 'rerun-repo',
    runContext: {
      kind: 'workspace-run',
      projectId: 'rerun-repo',
      hostId: 'local',
      projectHostSetupId: 'unavailable-test-setup',
      repoId: 'rerun-repo',
      path: testRepoPath
    },
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'America/Los_Angeles',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: OLDER_OCCURRENCE,
    enabled: false,
    nextRunAt: NEWER_OCCURRENCE,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 60,
    createdAt: OLDER_OCCURRENCE,
    updatedAt: NEWER_OCCURRENCE
  }
  // The missing setup stops dispatch before any agent can launch, after the real owner fence.
  writeFileSync(
    path.join(session.userDataDir, 'orca-data.json'),
    JSON.stringify({
      ...getE2ECompletedOnboardingProfile(),
      repos: [
        {
          id: 'rerun-repo',
          path: testRepoPath,
          displayName: 'Rerun test project',
          badgeColor: '#737373',
          addedAt: OLDER_OCCURRENCE
        }
      ],
      automations: [automation],
      automationRuns: [
        failedRun(OLDER_RUN_ID, 1, OLDER_OCCURRENCE),
        failedRun('newer-failed-run', 2, NEWER_OCCURRENCE)
      ]
    })
  )

  const { app, page } = await session.launch()
  try {
    await waitForSessionReady(page)
    await page.setViewportSize({ width: 1200, height: 850 })
    await page.evaluate(() => window.__store?.getState().openAutomationsPage())
    await page.getByRole('button', { name: 'Runs', exact: true }).click()
    const rows = page.getByTestId('automation-runs-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText(`${AUTOMATION_NAME} run 2`)
    await rows.filter({ hasText: `${AUTOMATION_NAME} run 1` }).click()
    await expect(page.getByText('Synthetic failure for run 1', { exact: true })).toBeVisible()
    const originalDate = (await page.getByRole('list', { name: 'Run context' }).innerText()).split(
      ' ('
    )[0]
    await testInfo.attach('selected-older-failed-run', {
      body: await page.screenshot({ path: testInfo.outputPath('selected-older-failed-run.png') }),
      contentType: 'image/png'
    })

    await page.getByRole('button', { name: 'Rerun', exact: true }).click()
    await expect(page.getByText('Automation run queued.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to runs' }).click()
    const firstRetry = rows.filter({ hasText: `${AUTOMATION_NAME} run 3` })
    await expect(firstRetry).toBeVisible()
    await expect(firstRetry).toContainText(originalDate)
    await expect(firstRetry).toContainText('manual')
    await firstRetry.click()
    await expect(
      page.getByText('Project is not set up on the selected automation host anymore.', {
        exact: true
      })
    ).toBeVisible()
    await expect(page.getByRole('list', { name: 'Run context' })).toContainText(originalDate)
    await testInfo.attach('retry-keeps-original-occurrence', {
      body: await page.screenshot({
        path: testInfo.outputPath('retry-keeps-original-occurrence.png')
      }),
      contentType: 'image/png'
    })

    await page.getByRole('button', { name: 'Rerun', exact: true }).click()
    await expect(page.getByText('Automation run queued.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to runs' }).click()
    const secondRetry = rows.filter({ hasText: `${AUTOMATION_NAME} run 4` })
    await expect(secondRetry).toBeVisible()
    await expect(secondRetry).toContainText(originalDate)

    const history = await page.evaluate(async (automationId) => {
      const response = await window.api.runtime.call({
        method: 'automation.runs',
        params: { automationId }
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    }, AUTOMATION_ID)
    expect(history).toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({
          runNumber: 3,
          scheduledFor: OLDER_OCCURRENCE,
          scheduledTimezone: 'UTC',
          rerun: { sourceRunId: OLDER_RUN_ID, originalRunId: OLDER_RUN_ID }
        }),
        expect.objectContaining({
          runNumber: 4,
          scheduledFor: OLDER_OCCURRENCE,
          scheduledTimezone: 'UTC',
          rerun: { sourceRunId: expect.any(String), originalRunId: OLDER_RUN_ID }
        })
      ])
    })
    await expect(rows).toHaveCount(4)
    await testInfo.attach('historical-retry-lineage', {
      body: await page.screenshot({ path: testInfo.outputPath('historical-retry-lineage.png') }),
      contentType: 'image/png'
    })
    writeFileSync(testInfo.outputPath('rerun-history.json'), JSON.stringify(history, null, 2))
    await testInfo.attach('rerun-history', {
      body: JSON.stringify(history, null, 2),
      contentType: 'application/json'
    })
  } finally {
    await session.close(app)
    await session.dispose()
  }
})
