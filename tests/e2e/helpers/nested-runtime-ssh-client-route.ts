import { expect } from './orca-app'
import type {
  createRuntimeDesktopPairingOffer,
  PairedElectronClient
} from './paired-electron-client'
import { focusActiveTerminalInput, getTerminalContent, waitForActivePanePtyId } from './terminal'
import { worktreeRowSurface } from '../worktree-row-locators'

export type ProjectedWorktreeRoute = {
  worktreeId: string
  worktreePath: string
  repoExecutionHostId: string | null | undefined
  worktreeHostId: string | null | undefined
  runtimeOwnerEnvironmentId: string | null | undefined
  localSshTargetIds: string[]
  runtimeSshState: string | null
}

export { assertNestedFilesystemRoute } from './nested-runtime-ssh-filesystem-route'
export { assertPairedTerminalCreation } from './nested-runtime-ssh-terminal-creation'

export function terminalMarkerCommand(marker: string): string {
  const encoded = [...marker]
    .map((character) => `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`)
    .join('')
  return `printf '${encoded}\\n'`
}

export async function assertNestedTerminalDestination(
  client: PairedElectronClient,
  expectedSentinel: string
): Promise<void> {
  await focusActiveTerminalInput(client.page)
  await client.page.keyboard.insertText('cat .orca-e2e-destination-id')
  await client.page.keyboard.press('Enter')
  await expect
    .poll(() => getTerminalContent(client.page), { timeout: 15_000 })
    .toContain(expectedSentinel)
}

async function captureNestedTerminalRouteDiagnostic(
  client: PairedElectronClient,
  repoId: string
): Promise<unknown> {
  return client.page.evaluate(
    async ({ environmentId, repoId }) => {
      const state = window.__store?.getState()
      const matches = Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .filter((worktree) => worktree.repoId === repoId)
      const worktreeId = state?.activeWorktreeId ?? null
      const tabs = worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []) : []
      const tabId = state?.activeTabId ?? tabs[0]?.id ?? null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const leafId = pane?.leafId ?? null
      const paneKey = tabId && leafId ? `${tabId}:${leafId}` : null
      const resolvePane =
        paneKey && worktreeId
          ? await window.api.runtimeEnvironments.call({
              selector: environmentId,
              method: 'terminal.resolvePane',
              params: { paneKey, worktreeId }
            })
          : null
      const runtimeTabs = worktreeId
        ? await window.api.runtimeEnvironments.call({
            selector: environmentId,
            method: 'session.tabs.list',
            params: { worktree: `id:${worktreeId}` }
          })
        : null
      return {
        activeRuntimeEnvironmentId: state?.settings.activeRuntimeEnvironmentId ?? null,
        environmentId,
        environments: await window.api.runtimeEnvironments.list(),
        leafId,
        localSshStates: [...(state?.sshConnectionStates.entries() ?? [])],
        matches: matches.map((worktree) => ({
          id: worktree.id,
          hostId: worktree.hostId,
          runtimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId
        })),
        paneKey,
        panePtyId: pane?.container?.dataset?.ptyId ?? null,
        ptyConnect: (globalThis as typeof globalThis & { __ptyConnectDiag?: string[] })
          .__ptyConnectDiag,
        runtimeStatus: state?.runtimeStatusByEnvironmentId.get(environmentId),
        repos: state?.repos
          .filter((repo) => repo.id === repoId)
          .map((repo) => ({
            id: repo.id,
            connectionId: repo.connectionId,
            executionHostId: repo.executionHostId
          })),
        resolvePane,
        runtimeTabs:
          runtimeTabs && runtimeTabs.ok
            ? {
                runtimeId: runtimeTabs._meta.runtimeId,
                tabs: (
                  runtimeTabs.result as {
                    tabs?: { id: string; ptyId?: string; status?: string; terminal?: string }[]
                  }
                ).tabs?.map((tab) => ({
                  id: tab.id,
                  ptyId: tab.ptyId,
                  status: tab.status,
                  terminal: tab.terminal
                }))
              }
            : runtimeTabs,
        runtimeSshBuckets: [...(state?.sshStateByEnvironment.entries() ?? [])].map(
          ([owner, bucket]) => ({
            owner,
            statuses: [...bucket.connectionStates.entries()],
            targets: bucket.targets?.map((target) => target.id) ?? [],
            targetsHydrated: bucket.targetsHydrated
          })
        ),
        tabId,
        tabs,
        worktreeId
      }
    },
    { environmentId: client.environmentId, repoId }
  )
}

async function activateRepoTerminal(
  client: PairedElectronClient,
  repoId: string
): Promise<ProjectedWorktreeRoute> {
  const route = await client.page.evaluate(async (repoId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired desktop store is unavailable')
    }
    await store.getState().fetchWorktrees(repoId)
    const state = store.getState()
    const repo = state.repos.find((candidate) => candidate.id === repoId)
    const worktree = state.worktreesByRepo[repoId]?.find((candidate) => candidate.isMainWorktree)
    if (!repo || !worktree) {
      throw new Error(`Paired desktop did not project repo/worktree ${repoId}`)
    }
    return {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      repoExecutionHostId: repo.executionHostId,
      worktreeHostId: worktree.hostId,
      runtimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId,
      localSshTargetIds: (await window.api.ssh.listTargets()).map((target) => target.id),
      runtimeSshState:
        store
          .getState()
          .sshStateByEnvironment.get(worktree.runtimeOwnerEnvironmentId ?? '')
          ?.connectionStates.get(repo.connectionId ?? '')?.status ?? null
    }
  }, repoId)
  await worktreeRowSurface(client.page, route.worktreeId).click()
  return route
}

export async function assertInteractiveTerminal(
  client: PairedElectronClient,
  repoId: string,
  marker: string,
  options: { waitForReconnectReady?: boolean } = {}
): Promise<ProjectedWorktreeRoute & { ptyId: string }> {
  const route = await activateRepoTerminal(client, repoId)
  const ensureWorktreeActive = async () => {
    const state = await client.page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      const hasBoundTerminal = (state?.tabsByWorktree[worktreeId] ?? []).some(
        (tab) => typeof tab.ptyId === 'string' && tab.ptyId.length > 0
      )
      return {
        active: state?.activeWorktreeId === worktreeId,
        hasBoundTerminal
      }
    }, route.worktreeId)
    if (!state.active) {
      await worktreeRowSurface(client.page, route.worktreeId).click()
    }
    return state.active && state.hasBoundTerminal
  }
  try {
    await expect
      .poll(
        async () => {
          const renderedWorktreeId = await client.page
            .locator('[data-rendered-active-worktree-id]')
            .getAttribute('data-rendered-active-worktree-id')
          if (renderedWorktreeId !== route.worktreeId) {
            await ensureWorktreeActive()
          }
          return renderedWorktreeId
        },
        { timeout: 30_000, intervals: [100, 250, 500] }
      )
      .toBe(route.worktreeId)
  } catch (error) {
    const diagnostic = await captureNestedTerminalRouteDiagnostic(client, repoId)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`
    )
  }
  let ptyId: string
  try {
    ptyId = await waitForActivePanePtyId(client.page, 30_000)
  } catch (error) {
    const diagnostic = await captureNestedTerminalRouteDiagnostic(client, repoId)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`
    )
  }
  if (options.waitForReconnectReady) {
    try {
      await expect
        .poll(
          async () => {
            try {
              if (!(await ensureWorktreeActive())) {
                return ''
              }
              await focusActiveTerminalInput(client.page)
              await client.page.keyboard.press('Control+C')
              await client.page.keyboard.insertText(terminalMarkerCommand(marker))
              await client.page.keyboard.press('Enter')
            } catch {
              return ''
            }
            return getTerminalContent(client.page)
          },
          {
            timeout: 30_000,
            intervals: [250, 500, 1_000],
            message: 'Remote terminal did not accept streamed input after reconnect'
          }
        )
        .toContain(marker)
    } catch (error) {
      const diagnostic = await captureNestedTerminalRouteDiagnostic(client, repoId)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`
      )
    }
    ptyId = await waitForActivePanePtyId(client.page, 30_000)
    return { ...route, ptyId }
  }
  await expect
    .poll(
      async () => {
        try {
          if (!(await ensureWorktreeActive())) {
            return ''
          }
          await focusActiveTerminalInput(client.page)
          await client.page.keyboard.press('Control+C')
          await client.page.keyboard.insertText(terminalMarkerCommand(marker))
          await client.page.keyboard.press('Enter')
        } catch {
          return ''
        }
        return getTerminalContent(client.page)
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Expected interactive terminal output for ${repoId}`
      }
    )
    .toContain(marker)
  return { ...route, ptyId }
}

export async function addPairedRuntimeEnvironment(
  client: PairedElectronClient,
  offer: Awaited<ReturnType<typeof createRuntimeDesktopPairingOffer>>,
  name: string
): Promise<string> {
  return client.page.evaluate(
    async ({ name, pairingUrl }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name,
        pairingCode: pairingUrl
      })
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(result.environment.id))) {
        throw new Error(`Paired desktop could not reach ${name}`)
      }
      if (!(await store.getState().switchRuntimeEnvironment(result.environment.id))) {
        throw new Error(`Paired desktop could not select ${name}`)
      }
      return result.environment.id
    },
    { name, pairingUrl: offer.pairingUrl }
  )
}
