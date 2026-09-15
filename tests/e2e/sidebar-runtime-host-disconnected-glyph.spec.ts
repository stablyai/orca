import type { Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const ENVIRONMENT_ID = 'e2e-remote-host'
const HOST_LABEL = 'Remote Mac'

type RecordedState = 'no-entry' | 'probed-unreachable' | 'probed-reachable'

/** Put the seeded worktree's repo on a runtime host and record one status verdict for it. */
async function seedRuntimeHost(page: Page, recorded: RecordedState): Promise<string> {
  return page.evaluate(
    ({ environmentId, hostLabel, recorded }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo).flat()[0]
      if (!worktree) {
        throw new Error('no seeded worktree to place on a runtime host')
      }
      state.setRuntimeEnvironments([
        {
          id: environmentId,
          name: hostLabel,
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: 'e2e-runtime',
          endpoints: [
            { id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://127.0.0.1:1' }
          ],
          preferredEndpointId: 'ws'
        }
      ])
      store.setState({
        repos: state.repos.map((repo) =>
          repo.id === worktree.repoId
            ? { ...repo, connectionId: undefined, executionHostId: `runtime:${environmentId}` }
            : repo
        )
      })
      if (recorded === 'probed-unreachable') {
        state.setRuntimeEnvironmentStatus(environmentId, { status: null, checkedAt: Date.now() })
      }
      if (recorded === 'probed-reachable') {
        state.setRuntimeEnvironmentStatus(environmentId, {
          status: {
            runtimeId: 'e2e-runtime',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: 1,
            desktopWindowStatus: 'available',
            liveTabCount: 0,
            liveLeafCount: 0
          },
          checkedAt: Date.now()
        })
      }
      return worktree.id
    },
    { environmentId: ENVIRONMENT_ID, hostLabel: HOST_LABEL, recorded }
  )
}

async function captureCard(card: Locator, testInfo: TestInfo, name: string): Promise<void> {
  const shot = testInfo.outputPath(name)
  await card.screenshot({ path: shot, animations: 'disabled' })
  await testInfo.attach(name, { path: shot, contentType: 'image/png' })
}

test.describe('sidebar runtime host glyph', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  // Why: an absent entry means "not probed yet". Painting it destructive made every
  // remote card red and dimmed between launch and the first probe answering.
  test('does not call a runtime host disconnected before its first probe answers', async ({
    orcaPage
  }, testInfo) => {
    await seedRuntimeHost(orcaPage, 'no-entry')
    const card = orcaPage.locator(`[data-worktree-card-surface="true"]`).first()
    await expect(card).toBeVisible()

    // Captured before the assertions so a regression run still yields the evidence image.
    await captureCard(card, testInfo, 'runtime-host-glyph-before-probe.png')

    await expect(card.locator('svg.lucide-server')).toBeVisible()
    await expect(card.locator('svg.lucide-server-off')).toHaveCount(0)
    await expect(card).not.toHaveClass(/opacity-60/)
  })

  // The deliberate no-change case: a probe actually reported this host unreachable.
  test('still marks a runtime host disconnected once a probe finds it unreachable', async ({
    orcaPage
  }, testInfo) => {
    await seedRuntimeHost(orcaPage, 'probed-unreachable')
    const card = orcaPage.locator(`[data-worktree-card-surface="true"]`).first()
    await expect(card).toBeVisible()

    await captureCard(card, testInfo, 'runtime-host-glyph-disconnected.png')

    await expect(card.locator('svg.lucide-server-off')).toBeVisible()
    await expect(card).toHaveClass(/opacity-60/)
  })

  test('clears the disconnected glyph when a later probe reaches the host', async ({
    orcaPage
  }, testInfo) => {
    await seedRuntimeHost(orcaPage, 'probed-unreachable')
    const card = orcaPage.locator(`[data-worktree-card-surface="true"]`).first()
    await expect(card.locator('svg.lucide-server-off')).toBeVisible()

    await seedRuntimeHost(orcaPage, 'probed-reachable')
    await captureCard(card, testInfo, 'runtime-host-glyph-recovered.png')

    await expect(card.locator('svg.lucide-server')).toBeVisible()
    await expect(card.locator('svg.lucide-server-off')).toHaveCount(0)
    await expect(card).not.toHaveClass(/opacity-60/)
  })
})
