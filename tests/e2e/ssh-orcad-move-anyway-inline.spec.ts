// #29083: a host whose move a saved automation refuses offers Move anyway on its card, and that connects it.
// ORCA_E2E_ORCAD_CONVERT_HOST=docker; ORCA_E2E_ORCAD_CONVERT_TEMPLATE must be built for the Docker host.
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { openSshHostSettings } from './helpers/ssh-config-host-picker'
import { managedServer } from './helpers/orcad-convert-flow'
import {
  ORCAD_CONVERT_HOST_ENV,
  startOrcadConvertHost,
  type OrcadConvertHost
} from './helpers/orcad-convert-host'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE

test.skip(
  HOST !== 'docker' || !TEMPLATE_SOURCE,
  `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
)

let host: OrcadConvertHost | null = null
test.afterEach(() => {
  host?.cleanup()
  host = null
})

// Pinned to an earlier registration of this host, so the server can't take it over and it stays behind.
function seedStrandedAutomation(userDataDir: string, repoId: string, targetId: string): void {
  const now = Date.now()
  const automationId = `automation-${now}`
  mutateStoppedProfileState(userDataDir, (state: Record<string, unknown>) => {
    state.automations = [
      {
        id: automationId,
        name: 'nightly check',
        prompt: 'check',
        precheck: null,
        agentId: 'claude',
        projectId: repoId,
        executionTargetType: 'ssh',
        executionTargetId: targetId,
        executionTargetGeneration: 9_999,
        schedulerOwner: 'ssh_bridge',
        workspaceMode: 'new_per_run',
        workspaceId: null,
        baseBranch: null,
        reuseSession: false,
        timezone: 'UTC',
        rrule: 'FREQ=DAILY',
        dtstart: now - 86_400_000,
        enabled: true,
        nextRunAt: now + 86_400_000,
        missedRunPolicy: 'run_once_within_grace',
        missedRunGraceMinutes: 60,
        createdAt: now - 86_400_000,
        updatedAt: now - 86_400_000
      }
    ]
    state.automationRuns = [1, 2].map((n) => ({
      id: `${automationId}-run-${n}`,
      automationId,
      title: `run ${n}`,
      scheduledFor: now - n * 3_600_000,
      status: 'completed',
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
      error: null,
      startedAt: now - n * 3_600_000,
      dispatchedAt: now - n * 3_600_000,
      createdAt: now - n * 3_600_000,
      runNumber: n
    }))
  })
}

test('a move a saved automation refuses offers Move anyway on the host card', async ({
  testRepoPath
}, testInfo) => {
  // Starts a Docker host and two app launches, then converts the host.
  test.setTimeout(10 * 60_000)
  host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    seedStrandedAutomation(session.userDataDir, seeded.repoId, seeded.targetId)
    const upgraded = await session.launch()
    app = upgraded.app
    const page = upgraded.page
    await waitForSessionReady(page)
    const section = await openSshHostSettings(page)
    const card = section.locator(
      `[data-ssh-target-card][data-ssh-target-label="${host.input.label}"]`
    )
    await card.hover()
    await card.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(card).toContainText(
      'Some saved items for this host can’t move to its Orca server: automations (1), automation runs (2). Move anyway connects the host and keeps them on this computer.',
      { timeout: 4 * 60_000 }
    )
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'automations (1)' })
    await expect(toast.getByRole('button', { name: 'Move anyway…' })).toBeVisible()
    const moveAnyway = card.getByRole('button', { name: 'Move anyway…', exact: true })
    await expect(moveAnyway).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('refused.png') })
    await moveAnyway.click()
    await page.getByRole('dialog').getByRole('button', { name: 'Move anyway', exact: true }).click()
    await expect
      .poll(() => managedServer(page, seeded.targetId), { timeout: 4 * 60_000 })
      .toMatchObject({ kind: 'managed' })
    await expect(card).toContainText('Connected', { timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath('moved.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
