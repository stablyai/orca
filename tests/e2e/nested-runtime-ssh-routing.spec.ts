import type { Page } from '@stablyai/playwright-test'
import { expect, test as base } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  dockerSshRelayRepoSentinel,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  launchPairedWebClient,
  rePairPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId
} from './helpers/terminal'
import {
  assertInteractiveTerminal,
  assertNestedFilesystemRoute,
  assertNestedTerminalDestination,
  assertPairedTerminalCreation,
  terminalMarkerCommand
} from './helpers/nested-runtime-ssh-client-route'
import { assertRuntimeSshStatus } from './helpers/nested-runtime-ssh-state'
import { restartProxyJumpDetachedRelay } from './helpers/nested-runtime-ssh-relay-lifecycle'
import {
  createNestedRuntimeProxyJumpFixture,
  type NestedRuntimeProxyJumpFixture
} from './helpers/nested-runtime-proxy-jump-fixture'
import {
  assertPairedWebLocalFilesystemMutations,
  assertPairedWebSshFilesystemMutations
} from './helpers/paired-web-filesystem-route'
import { worktreeRow, worktreeRowSurface } from './worktree-row-locators'

const isDockerNestedRuntimeRun =
  process.env.ORCA_E2E_NESTED_RUNTIME_SSH === '1' && process.env.ORCA_E2E_WEB_CLIENT === '1'

const test = base.extend<{ proxyJumpFixture: NestedRuntimeProxyJumpFixture | null }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  proxyJumpFixture: async ({}, provideFixture) => {
    if (!isDockerNestedRuntimeRun || process.platform === 'win32') {
      await provideFixture(null)
      return
    }
    const fixture = createNestedRuntimeProxyJumpFixture()
    try {
      await provideFixture(fixture)
    } finally {
      fixture.dispose()
    }
  },
  orcaAppExtraEnv: async ({ proxyJumpFixture }, provideFixture) => {
    await provideFixture(
      proxyJumpFixture ? { ORCA_SYSTEM_SSH_PATH: proxyJumpFixture.wrapperPath } : {}
    )
  }
})

test.skip(
  !isDockerNestedRuntimeRun,
  'Run with ORCA_E2E_NESTED_RUNTIME_SSH=1 and ORCA_E2E_WEB_CLIENT=1'
)
test.skip(process.platform === 'win32', 'ProxyJump fixture requires POSIX OpenSSH tooling')

async function installProxyJumpFixture(
  fixture: NestedRuntimeProxyJumpFixture,
  destination: DockerSshRelayTarget,
  jump: DockerSshRelayTarget
): Promise<void> {
  fixture.writeConfig(
    [
      'Host orca-e2e-jump',
      '  HostName 127.0.0.1',
      `  Port ${jump.port}`,
      '  User root',
      `  IdentityFile ${jump.identityFile}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking no',
      '  UserKnownHostsFile /dev/null',
      '',
      'Host orca-e2e-destination',
      `  HostName ${destination.containerIp}`,
      '  Port 22',
      '  User root',
      `  IdentityFile ${destination.identityFile}`,
      '  IdentitiesOnly yes',
      '  ProxyJump orca-e2e-jump',
      '  StrictHostKeyChecking no',
      '  UserKnownHostsFile /dev/null',
      ''
    ].join('\n')
  )
}

async function activateHubRepoTerminal(page: Page, repoId: string): Promise<string> {
  return page.evaluate(async (repoId) => {
    const store = window.__store
    if (!store) {
      throw new Error('HUB store is unavailable')
    }
    await store.getState().fetchWorktrees(repoId)
    const worktree = store
      .getState()
      .worktreesByRepo[repoId]?.find((candidate) => candidate.isMainWorktree)
    if (!worktree) {
      throw new Error(`HUB worktree ${repoId} is unavailable`)
    }
    store.getState().setActiveWorktree(worktree.id)
    if ((store.getState().tabsByWorktree[worktree.id] ?? []).length === 0) {
      store.getState().createTab(worktree.id)
    }
    store.getState().setActiveTabType('terminal')
    return worktree.id
  }, repoId)
}

async function assertHubTerminal(page: Page, repoId: string, marker: string): Promise<string> {
  const worktreeId = await activateHubRepoTerminal(page, repoId)
  try {
    await waitForActivePanePtyId(page, 30_000)
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId ?? null
      const tabs = worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []) : []
      return {
        activeTabId: state?.activeTabId ?? null,
        activeTabType: state?.activeTabType ?? null,
        activeWorktreeId: worktreeId,
        panes: [...(window.__paneManagers?.entries() ?? [])].map(([tabId, manager]) => ({
          tabId,
          ptyIds: (manager.getPanes?.() ?? []).map((pane) => pane.container.dataset.ptyId ?? null)
        })),
        ptyIdsByTabId: state?.ptyIdsByTabId ?? {},
        tabs
      }
    })
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`
    )
  }
  await focusActiveTerminalInput(page)
  await page.keyboard.insertText(terminalMarkerCommand(marker))
  await page.keyboard.press('Enter')
  await expect.poll(() => getTerminalContent(page), { timeout: 30_000 }).toContain(marker)
  return worktreeId
}

async function assertWebTerminal(page: Page, worktreeId: string, marker: string): Promise<void> {
  await expect(worktreeRow(page, worktreeId)).toBeVisible({ timeout: 30_000 })
  let lastActivationAttempt = 0
  try {
    await expect
      .poll(
        async () => {
          const state = await page.evaluate((worktreeId) => {
            const current = window.__store?.getState()
            const tabs = current?.tabsByWorktree[worktreeId] ?? []
            return {
              active: current?.activeWorktreeId === worktreeId,
              hasBoundTerminal: tabs.some(
                (tab) => (current?.ptyIdsByTabId[tab.id] ?? []).length > 0
              )
            }
          }, worktreeId)
          const now = Date.now()
          if ((!state.active || !state.hasBoundTerminal) && now - lastActivationAttempt >= 2_000) {
            lastActivationAttempt = now
            await worktreeRowSurface(page, worktreeId).click()
          }
          return state.active && state.hasBoundTerminal ? worktreeId : null
        },
        {
          timeout: 30_000,
          intervals: [100, 250, 500, 1_000],
          message: 'Paired web client did not receive a host-published terminal binding'
        }
      )
      .toBe(worktreeId)
  } catch (error) {
    const diagnostic = await page.evaluate(async (worktreeId) => {
      const state = window.__store?.getState()
      const worktree = Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((candidate) => candidate.id === worktreeId)
      const environmentId = worktree?.runtimeOwnerEnvironmentId ?? null
      const runtimeTabs = environmentId
        ? await window.api.runtimeEnvironments.call({
            selector: environmentId,
            method: 'session.tabs.list',
            params: { worktree: `id:${worktreeId}` }
          })
        : null
      return {
        activeTabId: state?.activeTabId ?? null,
        activeTabType: state?.activeTabType ?? null,
        activeWorktreeId: state?.activeWorktreeId ?? null,
        environmentId,
        environments: await window.api.runtimeEnvironments.list(),
        runtimeStatuses: [...(state?.runtimeStatusByEnvironmentId.entries() ?? [])],
        runtimeTabs,
        tabs: state?.tabsByWorktree[worktreeId] ?? [],
        worktree
      }
    }, worktreeId)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`
    )
  }
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    worktreeId
  )
  await expect
    .poll(
      async () => {
        if (!(await page.locator('body').innerText()).includes('SSH connection required')) {
          return 'ready'
        }
        return page.evaluate((worktreeId) => {
          const state = window.__store?.getState()
          const worktree = Object.values(state?.worktreesByRepo ?? {})
            .flat()
            .find((candidate) => candidate.id === worktreeId)
          const repo = state?.repos.find((candidate) => candidate.id === worktree?.repoId)
          return JSON.stringify({
            activeRuntimeEnvironmentId: state?.settings?.activeRuntimeEnvironmentId ?? null,
            activeWorktreeId: state?.activeWorktreeId ?? null,
            localSshStatus: repo?.connectionId
              ? (state?.sshConnectionStates.get(repo.connectionId)?.status ?? null)
              : null,
            repo,
            runtimeBuckets: [...(state?.sshStateByEnvironment.entries() ?? [])].map(
              ([environmentId, bucket]) => ({
                environmentId,
                statuses: [...bucket.connectionStates.entries()].map(([targetId, value]) => [
                  targetId,
                  value.status
                ]),
                targetsHydrated: bucket.targetsHydrated
              })
            ),
            runtimeStatuses: [...(state?.runtimeStatusByEnvironmentId.entries() ?? [])].map(
              ([environmentId, value]) => [environmentId, Boolean(value.status)]
            ),
            worktree
          })
        }, worktreeId)
      },
      { timeout: 30_000, message: 'Paired web client showed a client-local SSH reconnect gate' }
    )
    .toBe('ready')
  try {
    await waitForActivePanePtyId(page, 30_000)
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId ?? null
      const tabs = worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []) : []
      return {
        activeTabId: state?.activeTabId ?? null,
        activeTabType: state?.activeTabType ?? null,
        activeWorktreeId: worktreeId,
        panes: [...(window.__paneManagers?.entries() ?? [])].map(([tabId, manager]) => ({
          tabId,
          ptyIds: (manager.getPanes?.() ?? []).map((pane) => pane.container.dataset.ptyId ?? null)
        })),
        ptyIdsByTabId: state?.ptyIdsByTabId ?? {},
        tabs
      }
    })
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`
    )
  }
  await expect
    .poll(
      async () => {
        try {
          await focusActiveTerminalInput(page)
          await page.keyboard.press('Control+C')
          await page.keyboard.insertText(terminalMarkerCommand(marker))
          await page.keyboard.press('Enter')
        } catch {
          return ''
        }
        return getTerminalContent(page)
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Expected paired web terminal output for ${worktreeId}`
      }
    )
    .toContain(marker)
}

function remoteTerminalHandle(ptyId: string): string {
  const separator = ptyId.indexOf('@@')
  if (!ptyId.startsWith('remote:') || separator === -1) {
    throw new Error(`Expected runtime-owned PTY id, received ${ptyId}`)
  }
  return decodeURIComponent(ptyId.slice(separator + 2))
}

async function assertRuntimeTerminalLifecycle(
  client: PairedElectronClient,
  ptyId: string,
  marker: string
): Promise<void> {
  const terminal = remoteTerminalHandle(ptyId)
  const command = terminalMarkerCommand(marker)
  const response = await client.page.evaluate(
    async ({ command, environmentId, terminal }) => {
      const resize = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.resizeForClient',
        params: { terminal, mode: 'mobile-fit', cols: 91, rows: 31, clientId: 'nested-e2e' }
      })
      const send = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.send',
        params: {
          terminal,
          text: `stty size; ${command}\n`,
          client: { id: 'nested-e2e', type: 'desktop' }
        }
      })
      return { resize, send }
    },
    { command, environmentId: client.environmentId, terminal }
  )
  expect(response.resize.ok).toBe(true)
  expect(response.send.ok).toBe(true)
  await expect.poll(() => getTerminalContent(client.page), { timeout: 30_000 }).toContain('31 91')
  await expect.poll(() => getTerminalContent(client.page), { timeout: 30_000 }).toContain(marker)
  await expect
    .poll(
      () =>
        client.page.evaluate(
          async ({ environmentId, terminal }) => {
            const read = await window.api.runtimeEnvironments.call({
              selector: environmentId,
              method: 'terminal.read',
              params: { terminal, limit: 200 }
            })
            return read.ok ? JSON.stringify(read.result) : ''
          },
          { environmentId: client.environmentId, terminal }
        ),
      { timeout: 30_000 }
    )
    .toContain(marker)
}

async function reloadPairedClient(client: PairedElectronClient): Promise<void> {
  await client.captureDirectSshAttempts()
  await client.page.reload()
  await client.page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 30_000 }
  )
  const reachable = await client.page.evaluate((environmentId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired desktop store is unavailable after reload')
    }
    return store.getState().refreshRuntimeEnvironmentStatus(environmentId)
  }, client.environmentId)
  expect(reachable).toBe(true)
  await client.installDirectSshAttemptProbe()
}

async function assertRuntimeTerminalClose(
  client: PairedElectronClient,
  ptyId: string
): Promise<void> {
  const terminal = remoteTerminalHandle(ptyId)
  const close = await client.page.evaluate(
    ({ environmentId, terminal }) =>
      window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.close',
        params: { terminal }
      }),
    { environmentId: client.environmentId, terminal }
  )
  expect(close.ok).toBe(true)
  expect(close).toMatchObject({ result: { close: { handle: terminal, ptyKilled: true } } })
  try {
    await expect
      .poll(() =>
        client.page.evaluate((closedPtyId) => {
          for (const manager of window.__paneManagers?.values() ?? []) {
            for (const pane of manager.getPanes?.() ?? []) {
              if (pane.container?.dataset?.ptyId === closedPtyId) {
                return false
              }
            }
          }
          return true
        }, ptyId)
      )
      .toBe(true)
  } catch (error) {
    const diagnostic = await client.page.evaluate(
      async ({ closedPtyId, environmentId }) => {
        const panes = [...(window.__paneManagers?.entries() ?? [])].flatMap(([tabId, manager]) =>
          (manager.getPanes?.() ?? []).map((pane) => ({
            tabId,
            leafId: pane.leafId,
            ptyId: pane.container?.dataset?.ptyId ?? null
          }))
        )
        const state = window.__store?.getState()
        const listed = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'session.tabs.listAll',
          params: {}
        })
        return {
          panes: panes.filter((pane) => pane.ptyId === closedPtyId),
          tabs: Object.values(state?.tabsByWorktree ?? {})
            .flat()
            .filter((tab) => tab.ptyId === closedPtyId),
          layouts: Object.entries(state?.terminalLayoutsByTabId ?? {}).filter(([, layout]) =>
            Object.values(layout.ptyIdsByLeafId ?? {}).includes(closedPtyId)
          ),
          listed,
          ptyConnect: (globalThis as typeof globalThis & { __ptyConnectDiag?: string[] })
            .__ptyConnectDiag
        }
      },
      { closedPtyId: ptyId, environmentId: client.environmentId }
    )
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`
    )
  }
}

async function assertPairedPtyAbsent(client: PairedElectronClient, ptyId: string): Promise<void> {
  await expect
    .poll(
      () =>
        client.page.evaluate((closedPtyId) => {
          for (const manager of window.__paneManagers?.values() ?? []) {
            if (
              (manager.getPanes?.() ?? []).some(
                (pane) => pane.container?.dataset?.ptyId === closedPtyId
              )
            ) {
              return false
            }
          }
          return true
        }, ptyId),
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function activatePairedTerminalTab(
  client: PairedElectronClient,
  tabId: string,
  marker: string
): Promise<string> {
  const tab = client.page.locator(`[data-tab-id="${tabId}"]`).first()
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  await expect
    .poll(() =>
      client.page.evaluate((expectedTabId) => {
        const state = window.__store?.getState()
        return state?.activeTabId === expectedTabId ? expectedTabId : null
      }, tabId)
    )
    .toBe(tabId)
  const ptyId = await waitForActivePanePtyId(client.page, 30_000)
  await focusActiveTerminalInput(client.page)
  await client.page.keyboard.insertText(terminalMarkerCommand(marker))
  await client.page.keyboard.press('Enter')
  await expect.poll(() => getTerminalContent(client.page), { timeout: 30_000 }).toContain(marker)
  return ptyId
}

test.describe.configure({ mode: 'serial' })

test('routes HUB desktop, web, and two paired desktops through HUB-owned SSH', async ({
  orcaPage,
  electronApp,
  proxyJumpFixture
}, testInfo) => {
  test.setTimeout(720_000)
  let sshTarget: DockerSshRelayTarget | null = null
  let proxyJumpHost: DockerSshRelayTarget | null = null
  let proxyJumpDestination: DockerSshRelayTarget | null = null
  let clientA: PairedElectronClient | null = null
  let clientB: PairedElectronClient | null = null
  let webClient: Awaited<ReturnType<typeof launchPairedWebClient>> | null = null
  try {
    if (!proxyJumpFixture) {
      throw new Error('ProxyJump fixture requires a POSIX system SSH client')
    }
    sshTarget = startDockerSshRelayTarget(testInfo)
    proxyJumpHost = startDockerSshRelayTarget(testInfo)
    proxyJumpDestination = startDockerSshRelayTarget(testInfo)
    const remote = await connectDockerSshRelayTarget(orcaPage, sshTarget)
    await installProxyJumpFixture(proxyJumpFixture, proxyJumpDestination, proxyJumpHost)
    const proxyJumpRemote = await connectDockerSshRelayTarget(orcaPage, proxyJumpDestination, {
      viaProxyJump: true
    })
    const localRepoId = await orcaPage.evaluate(() => {
      const repo = window.__store?.getState().repos.find((candidate) => !candidate.connectionId)
      if (!repo) {
        throw new Error('HUB local repo is unavailable')
      }
      return repo.id
    })

    const hubLocalWorktreeId = await assertHubTerminal(
      orcaPage,
      localRepoId,
      `HUB_DESKTOP_LOCAL_${Date.now()}`
    )
    const hubSshWorktreeId = await assertHubTerminal(
      orcaPage,
      remote.repoId,
      `HUB_DESKTOP_SSH_${Date.now()}`
    )
    const hubProxyJumpWorktreeId = await assertHubTerminal(
      orcaPage,
      proxyJumpRemote.repoId,
      `HUB_DESKTOP_PROXY_JUMP_${Date.now()}`
    )

    const webOffer = await createRuntimeDesktopPairingOffer(orcaPage)
    webClient = await launchPairedWebClient(electronApp, webOffer)
    await assertWebTerminal(webClient.page, hubLocalWorktreeId, `HUB_WEB_LOCAL_${Date.now()}`)
    await assertPairedWebLocalFilesystemMutations(webClient.page, hubLocalWorktreeId)
    await assertWebTerminal(webClient.page, hubSshWorktreeId, `HUB_WEB_SSH_${Date.now()}`)
    await assertPairedWebSshFilesystemMutations(webClient.page, hubSshWorktreeId, sshTarget)
    await assertWebTerminal(
      webClient.page,
      hubProxyJumpWorktreeId,
      `HUB_WEB_PROXY_JUMP_${Date.now()}`
    )
    await assertPairedWebSshFilesystemMutations(
      webClient.page,
      hubProxyJumpWorktreeId,
      proxyJumpDestination
    )

    const offerA = await createRuntimeDesktopPairingOffer(orcaPage)
    clientA = await launchPairedElectronClient(offerA, testInfo, 'Nested SSH HUB A')

    const localRoute = await assertInteractiveTerminal(
      clientA,
      localRepoId,
      `PAIRED_A_LOCAL_${Date.now()}`
    )
    expect(localRoute.ptyId).toContain(encodeURIComponent(clientA.environmentId))

    const sshRoute = await assertInteractiveTerminal(
      clientA,
      remote.repoId,
      `PAIRED_A_SSH_${Date.now()}`
    )
    expect(sshRoute.localSshTargetIds).not.toContain(remote.targetId)
    expect(sshRoute.ptyId).toContain(encodeURIComponent(clientA.environmentId))
    expect(sshRoute.worktreeHostId).toBe(`ssh:${remote.targetId}`)
    expect(sshRoute.runtimeOwnerEnvironmentId).toBe(clientA.environmentId)
    await assertNestedTerminalDestination(
      clientA,
      dockerSshRelayRepoSentinel(sshTarget, DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    )
    const pairedCreatedTerminal = await assertPairedTerminalCreation(
      clientA,
      `PAIRED_A_CREATED_SSH_${Date.now()}`
    )
    expect(pairedCreatedTerminal.ptyId).toContain(encodeURIComponent(clientA.environmentId))
    expect(remoteTerminalHandle(pairedCreatedTerminal.ptyId)).not.toBe(
      remoteTerminalHandle(sshRoute.ptyId)
    )
    await assertNestedFilesystemRoute(clientA, sshRoute, {
      onRenamed: (absolutePath) => {
        expect(
          execDockerSshRelayTargetCommand(sshTarget!, `[ -f '${absolutePath}' ] && echo yes`)
        ).toBe('yes')
        expect(
          execDockerSshRelayTargetCommand(
            proxyJumpDestination!,
            `[ ! -e '${absolutePath}' ] && echo yes`
          )
        ).toBe('yes')
      }
    })
    await assertRuntimeTerminalLifecycle(
      clientA,
      pairedCreatedTerminal.ptyId,
      `RPC_STREAM_${Date.now()}`
    )
    const proxyJumpRoute = await assertInteractiveTerminal(
      clientA,
      proxyJumpRemote.repoId,
      `PAIRED_A_PROXY_JUMP_${Date.now()}`
    )
    expect(proxyJumpRoute.localSshTargetIds).not.toContain(proxyJumpRemote.targetId)
    expect(proxyJumpRoute.worktreeHostId).toBe(`ssh:${proxyJumpRemote.targetId}`)
    expect(proxyJumpRoute.runtimeOwnerEnvironmentId).toBe(clientA.environmentId)
    await assertNestedTerminalDestination(
      clientA,
      dockerSshRelayRepoSentinel(proxyJumpDestination, DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH)
    )
    await assertNestedFilesystemRoute(clientA, proxyJumpRoute, {
      onRenamed: (absolutePath) => {
        expect(
          execDockerSshRelayTargetCommand(
            proxyJumpDestination!,
            `[ -f '${absolutePath}' ] && echo yes`
          )
        ).toBe('yes')
        expect(
          execDockerSshRelayTargetCommand(sshTarget!, `[ ! -e '${absolutePath}' ] && echo yes`)
        ).toBe('yes')
      }
    })

    const offerB = await createRuntimeDesktopPairingOffer(orcaPage)
    clientB = await launchPairedElectronClient(offerB, testInfo, 'Nested SSH HUB B')
    const secondLocalRoute = await assertInteractiveTerminal(
      clientB,
      localRepoId,
      `PAIRED_B_LOCAL_${Date.now()}`
    )
    const secondViewerMarker = `PAIRED_B_SSH_${Date.now()}`
    const secondSshRoute = await assertInteractiveTerminal(
      clientB,
      remote.repoId,
      secondViewerMarker
    )
    expect(secondSshRoute.localSshTargetIds).toEqual([])
    expect(secondSshRoute.ptyId).toContain(encodeURIComponent(clientB.environmentId))
    expect(remoteTerminalHandle(secondSshRoute.ptyId)).toBe(remoteTerminalHandle(sshRoute.ptyId))
    expect(remoteTerminalHandle(secondSshRoute.ptyId)).not.toBe(
      remoteTerminalHandle(pairedCreatedTerminal.ptyId)
    )
    const sharedViewerMarker = `PAIRED_B_SHARED_${Date.now()}`
    const sharedCreatedPtyOnB = await activatePairedTerminalTab(
      clientB,
      pairedCreatedTerminal.tabId,
      sharedViewerMarker
    )
    expect(remoteTerminalHandle(sharedCreatedPtyOnB)).toBe(
      remoteTerminalHandle(pairedCreatedTerminal.ptyId)
    )
    const secondProxyJumpRoute = await assertInteractiveTerminal(
      clientB,
      proxyJumpRemote.repoId,
      `PAIRED_B_PROXY_JUMP_${Date.now()}`
    )
    expect(secondProxyJumpRoute.localSshTargetIds).toEqual([])
    expect(secondProxyJumpRoute.worktreeHostId).toBe(`ssh:${proxyJumpRemote.targetId}`)
    expect(remoteTerminalHandle(secondProxyJumpRoute.ptyId)).toBe(
      remoteTerminalHandle(proxyJumpRoute.ptyId)
    )

    const sharedRouteOnA = await assertInteractiveTerminal(
      clientA,
      remote.repoId,
      `PAIRED_A_SHARED_RETURN_${Date.now()}`
    )
    expect(remoteTerminalHandle(sharedRouteOnA.ptyId)).toBe(
      remoteTerminalHandle(pairedCreatedTerminal.ptyId)
    )
    await expect
      .poll(() => getTerminalContent(clientA!.page), { timeout: 30_000 })
      .toContain(sharedViewerMarker)

    await reloadPairedClient(clientA)
    const reloadedSshRoute = await assertInteractiveTerminal(
      clientA,
      remote.repoId,
      `PAIRED_A_RELOAD_${Date.now()}`
    )
    expect(reloadedSshRoute.localSshTargetIds).toEqual([])
    expect(reloadedSshRoute.runtimeOwnerEnvironmentId).toBe(clientA.environmentId)

    await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
    await assertRuntimeSshStatus(clientA, remote.targetId, 'disconnected')
    await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)
    await assertRuntimeSshStatus(clientA, remote.targetId, 'connected')
    const reconnectedSshRoute = await assertInteractiveTerminal(
      clientA,
      remote.repoId,
      `PAIRED_A_RELAY_RECONNECT_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    expect(reconnectedSshRoute.localSshTargetIds).toEqual([])

    await restartProxyJumpDetachedRelay(
      orcaPage,
      { label: 'direct', target: sshTarget, targetId: remote.targetId },
      {
        label: 'ProxyJump',
        target: proxyJumpDestination,
        targetId: proxyJumpRemote.targetId
      },
      [clientA, clientB]
    )
    const restartedRelayRoute = await assertInteractiveTerminal(
      clientA,
      remote.repoId,
      `PAIRED_A_RELAY_RESTART_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    const restartedProxyJumpRelayRoute = await assertInteractiveTerminal(
      clientA,
      proxyJumpRemote.repoId,
      `PAIRED_A_PROXY_RELAY_RESTART_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    expect(restartedProxyJumpRelayRoute.worktreeHostId).toBe(`ssh:${proxyJumpRemote.targetId}`)
    await assertNestedTerminalDestination(
      clientA,
      dockerSshRelayRepoSentinel(proxyJumpDestination, DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH)
    )
    const restartedRelayRouteOnB = await assertInteractiveTerminal(
      clientB,
      remote.repoId,
      `PAIRED_B_RELAY_RESTART_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    const convergedRelayRouteOnA = await assertInteractiveTerminal(
      clientA,
      remote.repoId,
      `PAIRED_A_RELAY_RESTART_CONVERGED_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    expect(remoteTerminalHandle(restartedRelayRouteOnB.ptyId)).toBe(
      remoteTerminalHandle(convergedRelayRouteOnA.ptyId)
    )
    await expect
      .poll(() => getTerminalContent(clientB!.page), { timeout: 30_000 })
      .toContain('PAIRED_A_RELAY_RESTART_CONVERGED_')
    await assertRuntimeTerminalClose(clientA, convergedRelayRouteOnA.ptyId)
    await assertPairedPtyAbsent(clientB, restartedRelayRouteOnB.ptyId)

    const rePairOffer = await createRuntimeDesktopPairingOffer(orcaPage)
    await rePairPairedElectronClient(clientA, rePairOffer, 'Nested SSH HUB A re-paired')
    await assertRuntimeSshStatus(clientA, remote.targetId, 'connected')
    const rePairedSshRoute = await assertInteractiveTerminal(
      clientA,
      remote.repoId,
      `PAIRED_A_REPAIRED_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    expect(rePairedSshRoute.localSshTargetIds).toEqual([])
    expect(rePairedSshRoute.runtimeOwnerEnvironmentId).toBe(clientA.environmentId)
    expect(await clientA.getDirectSshAttemptTargetIds()).toEqual([])
    expect(await clientB.getDirectSshAttemptTargetIds()).toEqual([])

    testInfo.annotations.push({
      type: 'nested-route',
      description: JSON.stringify({
        local: localRoute,
        ssh: sshRoute,
        pairedCreatedTerminal,
        proxyJump: proxyJumpRoute,
        rePairedSsh: rePairedSshRoute,
        reloadedSsh: reloadedSshRoute,
        reconnectedSsh: reconnectedSshRoute,
        restartedRelay: restartedRelayRoute,
        restartedRelayOnB: restartedRelayRouteOnB,
        restartedProxyJumpRelay: restartedProxyJumpRelayRoute,
        secondLocal: secondLocalRoute,
        secondSsh: secondSshRoute,
        sharedCreatedPtyOnB,
        secondProxyJump: secondProxyJumpRoute
      })
    })
  } finally {
    await clientB?.dispose()
    await clientA?.dispose()
    await webClient?.dispose()
    cleanupDockerSshRelayTarget(sshTarget)
    cleanupDockerSshRelayTarget(proxyJumpHost)
    cleanupDockerSshRelayTarget(proxyJumpDestination)
  }
})
