import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * The sidebar's remote-host verdict, rendered.
 *
 * A store-slice test cannot see that "no probe yet" and "probe said unreachable"
 * used to collapse into the same red glyph and dimmed card, because the collapse
 * happened in the selector feeding the card's render (#16516).
 */
const REMOTE_HOST = 'E2E Recovery Host'
const REMOTE_PROJECT = 'E2E Recovery Remote Project'
const REMOTE_WORKSPACE = 'E2E Recovery Remote Workspace'

type GlyphFixture = { environmentId: string; worktreeId: string }

async function seedRuntimeHostWorkspace(page: Page): Promise<GlyphFixture> {
  return page.evaluate(
    ({ remoteHost, remoteProject, remoteWorkspace }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const sourceRepo = state.repos[0]
      const sourceWorktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.repoId === sourceRepo?.id && !worktree.isArchived)
      if (!sourceRepo || !sourceWorktree) {
        throw new Error('Runtime host glyph E2E needs the seeded local repository')
      }

      const token = crypto.randomUUID()
      const environmentId = `e2e-recovery-env-${token}`
      const hostId: `runtime:${string}` = `runtime:${environmentId}`
      const remoteRepoId = `e2e-recovery-repo-${token}`
      const worktreeId = `e2e-recovery-worktree-${token}`
      const now = Date.now()
      const remoteWorktree: (typeof state.worktreesByRepo)[string][number] = {
        ...sourceWorktree,
        id: worktreeId,
        repoId: remoteRepoId,
        path: `${sourceWorktree.path}-e2e-recovery-${token}`,
        displayName: remoteWorkspace,
        branch: 'refs/heads/e2e-recovery',
        isMainWorktree: false,
        isArchived: false,
        hostId
      }

      store.setState({
        runtimeEnvironments: [
          {
            id: environmentId,
            name: remoteHost,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: now,
            runtimeId: `${environmentId}-runtime`,
            source: 'manual',
            preferredEndpointId: `ws-${environmentId}`,
            endpoints: [
              {
                id: `ws-${environmentId}`,
                kind: 'websocket',
                label: remoteHost,
                endpoint: 'ws://127.0.0.1:6768'
              }
            ]
          }
        ],
        // Start with no entry at all: the state right after launch, before the
        // boot probe has answered for this host.
        runtimeStatusByEnvironmentId: new Map(),
        repos: [
          ...state.repos,
          {
            ...sourceRepo,
            id: remoteRepoId,
            path: `${sourceRepo.path}-e2e-recovery-${token}`,
            displayName: remoteProject,
            connectionId: undefined,
            executionHostId: hostId
          }
        ],
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [remoteRepoId]: [remoteWorktree]
        }
      })

      return { environmentId, worktreeId }
    },
    { remoteHost: REMOTE_HOST, remoteProject: REMOTE_PROJECT, remoteWorkspace: REMOTE_WORKSPACE }
  )
}

type SeededProbeResult = 'reachable' | 'unreachable' | 'control-channel-closed'

async function recordProbeResult(
  page: Page,
  fixture: GlyphFixture,
  result: SeededProbeResult
): Promise<void> {
  await page.evaluate(
    ({ environmentId, result }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      store.setState({
        runtimeStatusByEnvironmentId: new Map(store.getState().runtimeStatusByEnvironmentId).set(
          environmentId,
          {
            checkedAt: Date.now(),
            status:
              result === 'unreachable'
                ? null
                : {
                    runtimeId: `${environmentId}-runtime`,
                    rendererGraphEpoch: 1,
                    graphStatus: 'ready',
                    authoritativeWindowId: 1,
                    desktopWindowStatus: 'available',
                    liveTabCount: 0,
                    liveLeafCount: 0,
                    // A host that answered status.get while its control channel is down: truthy
                    // status, disconnected verdict. The sidebar used to draw this one normally.
                    ...(result === 'control-channel-closed'
                      ? { remoteControl: { state: 'closed', lastError: 'Connection closed' } }
                      : {})
                  }
          }
        )
      })
    },
    { environmentId: fixture.environmentId, result }
  )
}

/**
 * Replaces the probe's network leg only. The scheduler, its backoff, the port's candidate
 * list, the real `setRuntimeEnvironmentStatus` publication and the card's selectors all still
 * run, so the recovery below is driven by the app, not by the test writing the status map.
 */
async function letTheNextProbeSucceed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const probedEnvironmentIds: string[] = []
    ;(window as never as { __probedEnvironmentIds: string[] }).__probedEnvironmentIds =
      probedEnvironmentIds
    store.setState({
      refreshRuntimeEnvironmentStatusOutcome: async (environmentId: string) => {
        probedEnvironmentIds.push(environmentId)
        store.getState().setRuntimeEnvironmentStatus(environmentId, {
          checkedAt: Date.now(),
          status: {
            runtimeId: `${environmentId}-runtime`,
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: 1,
            desktopWindowStatus: 'available',
            liveTabCount: 0,
            liveLeafCount: 0
          }
        } as never)
        return 'reachable'
      }
    } as never)
  })
}

function card(page: Page, fixture: GlyphFixture) {
  return page.locator(`[data-worktree-id="${fixture.worktreeId}"]`)
}

function surface(page: Page, fixture: GlyphFixture) {
  return card(page, fixture).locator('[data-worktree-card-surface="true"]')
}

/** Why by host name, not by copy: the harness runs in the user's locale. */
async function dismissTooltips(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  // Radix fades the tooltip out; screenshotting mid-fade paints it over the card.
  await expect(page.getByRole('tooltip').filter({ hasText: REMOTE_HOST })).toHaveCount(0)
}

async function readHostTooltip(page: Page, fixture: GlyphFixture, glyph: string): Promise<string> {
  await dismissTooltips(page)
  await card(page, fixture).locator(glyph).hover()
  const tooltip = page.getByRole('tooltip').filter({ hasText: REMOTE_HOST })
  await expect(tooltip).toBeVisible()
  return (await tooltip.innerText()).trim()
}

test.describe('Sidebar runtime host disconnected glyph', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('separates an unprobed remote host from one a probe reported unreachable', async ({
    orcaPage
  }, testInfo) => {
    const fixture = await seedRuntimeHostWorkspace(orcaPage)
    await expect(card(orcaPage, fixture)).toBeVisible()

    // P1: never probed. The host is unverifiable, not down — a plain server glyph
    // on a full-opacity card. This is what regressed for every remote card at launch.
    await expect(card(orcaPage, fixture).locator('svg.lucide-server')).toBeVisible()
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toHaveCount(0)
    await expect(surface(orcaPage, fixture)).not.toHaveClass(/opacity-60/)
    await card(orcaPage, fixture).screenshot({
      path: testInfo.outputPath('runtime-host-glyph-before-probe.png')
    })

    // P2: the probe answered "unreachable". Now, and only now, the card says so.
    await recordProbeResult(orcaPage, fixture, 'unreachable')
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toBeVisible()
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toHaveClass(
      /text-destructive/
    )
    await expect(surface(orcaPage, fixture)).toHaveClass(/opacity-60/)
    const disconnectedTooltip = await readHostTooltip(orcaPage, fixture, 'svg.lucide-server-off')
    expect(disconnectedTooltip).toContain(REMOTE_HOST)
    await dismissTooltips(orcaPage)
    await card(orcaPage, fixture).screenshot({
      path: testInfo.outputPath('runtime-host-glyph-disconnected.png')
    })

    // P3: a later probe finds it reachable — the card recovers without a reload.
    // Before the fix nothing could reach this state on its own after a boot failure.
    await recordProbeResult(orcaPage, fixture, 'reachable')
    await expect(card(orcaPage, fixture).locator('svg.lucide-server')).toBeVisible()
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toHaveCount(0)
    await expect(surface(orcaPage, fixture)).not.toHaveClass(/opacity-60/)
    // The copy tracks the verdict, so the two states cannot read the same in any locale.
    const recoveredTooltip = await readHostTooltip(orcaPage, fixture, 'svg.lucide-server')
    expect(recoveredTooltip).toContain(REMOTE_HOST)
    expect(recoveredTooltip).not.toBe(disconnectedTooltip)
    await dismissTooltips(orcaPage)
    await card(orcaPage, fixture).screenshot({
      path: testInfo.outputPath('runtime-host-glyph-recovered.png')
    })
  })

  test('recovers a red card through the recovery loop, not a store write', async ({
    orcaPage
  }, testInfo) => {
    // Why this second spec exists: the first one moves the card by writing the status map, so it
    // can show the rendered verdict but not that the unreachable state stops being terminal. Here
    // the only thing the test triggers is `online`; the app decides what to probe and when.
    const fixture = await seedRuntimeHostWorkspace(orcaPage)
    await expect(card(orcaPage, fixture)).toBeVisible()

    // A truthy status whose control channel closed with an error. The shared derivation the
    // status bar and Settings already used calls this disconnected; the sidebar did not.
    await recordProbeResult(orcaPage, fixture, 'control-channel-closed')
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toHaveClass(
      /text-destructive/
    )
    await expect(surface(orcaPage, fixture)).toHaveClass(/opacity-60/)
    await card(orcaPage, fixture).screenshot({
      path: testInfo.outputPath('runtime-host-glyph-control-channel-closed.png')
    })

    await letTheNextProbeSucceed(orcaPage)
    await orcaPage.evaluate(() => window.dispatchEvent(new Event('online')))

    await expect(card(orcaPage, fixture).locator('svg.lucide-server')).toBeVisible()
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toHaveCount(0)
    await expect(surface(orcaPage, fixture)).not.toHaveClass(/opacity-60/)
    // The loop had to enumerate this host to recover it: a private `status === null` candidate
    // list would have skipped it, leaving the red glyph the app itself painted (#16518 review).
    expect(
      await orcaPage.evaluate(
        () => (window as never as { __probedEnvironmentIds: string[] }).__probedEnvironmentIds
      )
    ).toContain(fixture.environmentId)
    await card(orcaPage, fixture).screenshot({
      path: testInfo.outputPath('runtime-host-glyph-loop-recovered.png')
    })
  })
})
