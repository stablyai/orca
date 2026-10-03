import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../src/shared/execution-host'
import { runProcess } from '../../src/shared/child-process/run-process'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { createHostRendererTerminalTab } from './helpers/host-created-terminal-retention-oracle'

test('switches the active server from the status bar between two paired hosts and local', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  const workOffer = await createRuntimeDesktopPairingOffer(orcaPage)
  let privateHost: PairedElectronClient | null = null
  let client: PairedElectronClient | null = null
  const privateRepoPath = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-private-project-'))
  )

  try {
    writeFileSync(path.join(privateRepoPath, 'README.md'), 'Private test project\n')
    for (const args of [
      ['init'],
      ['add', 'README.md'],
      ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-m', 'Initial commit']
    ]) {
      const result = await runProcess({ program: 'git', args, cwd: privateRepoPath })
      if (result.code !== 0) {
        throw new Error(`Could not prepare the private test project: ${result.stderr}`)
      }
    }
    privateHost = await launchPairedElectronClient(workOffer, testInfo, 'work')
    await privateHost.page.evaluate(async () => {
      if (!(await window.__store?.getState().setActiveRuntimeEnvironmentPreference(null))) {
        throw new Error('Could not prepare the second runtime host')
      }
    })
    await privateHost.page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.remove({ selector })
      const state = window.__store?.getState()
      state?.setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      await state?.fetchRepos()
      await state?.fetchAllWorktrees()
    }, privateHost.environmentId)
    const privateRepoId = await privateHost.page.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      await window.__store?.getState().fetchRepos()
      await window.__store?.getState().fetchWorktrees(result.repo.id)
      return result.repo.id
    }, privateRepoPath)
    const privateOffer = await createRuntimeDesktopPairingOffer(privateHost.page)
    client = await launchPairedElectronClient(workOffer, testInfo, 'work')
    const page = client.page
    await page.evaluate((hostId) => {
      window.__store?.getState().setVisibleWorkspaceHostIds([hostId])
    }, toRuntimeExecutionHostId(client.environmentId))
    // Hidden windows do not advance CSS animations; keep Radix's close transition deterministic.
    await page.addStyleTag({
      content: '* { animation: none !important; transition: none !important; }'
    })
    await page.evaluate(async (pairingUrl) => {
      await window.api.runtimeEnvironments.addFromPairingCode({
        name: 'priv',
        pairingCode: pairingUrl
      })
      window.__store?.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
    }, privateOffer.pairingUrl)

    const workTrigger = page.getByRole('button', { name: 'Remote Hosts: work', exact: true })
    await expect(workTrigger).toBeVisible()
    await expect(workTrigger).toContainText('work')
    const sidebar = page.locator('[data-worktree-sidebar]')
    await expect(sidebar.getByText(path.basename(testRepoPath), { exact: true })).toBeVisible()
    await expect(sidebar.getByText(path.basename(privateRepoPath), { exact: true })).toBeHidden()
    await workTrigger.press('ArrowDown')
    await expect(page.getByRole('menuitemradio', { name: 'work', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await expect(page.getByRole('menuitemradio', { name: 'work', exact: true })).toContainText(
      'Connected'
    )
    await expect(page.getByRole('menuitemradio', { name: 'priv', exact: true })).toContainText(
      'Connected'
    )
    await page.getByRole('menuitem', { name: 'work: Remote Server', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menuitem', { name: 'Disconnect', exact: true })).toBeVisible()
    await expect(workTrigger).toContainText('work')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(workTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('menu')).toBeHidden()

    await page.evaluate(async () => {
      const environmentId = window.__store
        ?.getState()
        .runtimeEnvironments.find((environment) => environment.name === 'priv')?.id
      if (!environmentId) {
        throw new Error('Private host was not paired')
      }
      await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
      await window.__store?.getState().readRuntimeHostStatusSnapshots()
    })
    await workTrigger.press('ArrowDown')
    const privateRadio = page.getByRole('menuitemradio', { name: 'priv', exact: true })
    await expect(privateRadio).toContainText('Disconnected')
    await expect(privateRadio).toHaveAttribute('aria-disabled', 'true')
    const privateRow = privateRadio.locator('..')
    await privateRow.getByRole('menuitem', { name: /^(Connect|Reconnect)$/ }).click({ force: true })
    await expect(privateRadio).toContainText('Connected')
    await expect(privateRadio).not.toHaveAttribute('aria-disabled', 'true')
    await expect(workTrigger).toContainText('work')
    await page.keyboard.press('Escape')

    await page.evaluate((hostId) => {
      const state = window.__store?.getState()
      const workspace = Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((row) => row.hostId === hostId && row.isMainWorktree)
      if (!state || !workspace) {
        throw new Error('Work checkout was not hydrated')
      }
      state.setActiveRepo(workspace.repoId)
      state.setActiveWorktree(workspace.id, hostId)
      state.markWorktreeVisited(workspace.id, undefined, hostId)
    }, toRuntimeExecutionHostId(client.environmentId))
    const workWorkspaceId = await orcaPage.evaluate(() => {
      const id = window.__store?.getState().activeWorktreeId
      if (!id) {
        throw new Error('Work host has no active checkout')
      }
      return id
    })
    const workTabId = toWebTerminalSurfaceTabId(
      await createHostRendererTerminalTab(orcaPage, workWorkspaceId)
    )
    const workTab = page.locator(`[data-tab-id="${workTabId}"]`)
    await expect(workTab).toBeVisible({ timeout: 60_000 })
    await workTab.click({ force: true })
    await expect(workTab).toHaveAttribute('data-active', 'true')

    await workTrigger.press('ArrowDown')
    await page.getByRole('menuitemradio', { name: 'priv', exact: true }).focus()
    await page.keyboard.press('Enter')
    const privateTrigger = page.getByRole('button', { name: 'Remote Hosts: priv', exact: true })
    await expect(privateTrigger).toBeVisible()
    await expect(privateTrigger).toBeEnabled()
    await expect(sidebar.getByText(path.basename(privateRepoPath), { exact: true })).toBeVisible()
    await expect(sidebar.getByText(path.basename(testRepoPath), { exact: true })).toBeHidden()

    await expect(workTab).toBeHidden()
    await page.evaluate(() => {
      const state = window.__store?.getState()
      const environmentId = state?.settings?.activeRuntimeEnvironmentId
      const hostId: ExecutionHostId | null = environmentId
        ? `runtime:${encodeURIComponent(environmentId)}`
        : null
      const workspace = Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((row) => row.hostId === hostId && row.isMainWorktree)
      if (!state || !workspace || !hostId) {
        throw new Error('Private checkout was not hydrated')
      }
      state.setActiveRepo(workspace.repoId)
      state.setActiveWorktree(workspace.id, hostId)
      state.markWorktreeVisited(workspace.id, undefined, hostId)
    })
    const privateWorkspaceId = await privateHost.page.evaluate((repoId) => {
      const workspace = window.__store
        ?.getState()
        .worktreesByRepo[repoId]?.find((row) => row.isMainWorktree)
      if (!workspace) {
        throw new Error('Private host checkout was not hydrated')
      }
      return workspace.id
    }, privateRepoId)
    const privateTabId = toWebTerminalSurfaceTabId(
      await createHostRendererTerminalTab(privateHost.page, privateWorkspaceId)
    )
    const privateTab = page.locator(`[data-tab-id="${privateTabId}"]`)
    await expect(privateTab).toBeVisible({ timeout: 60_000 })
    await privateTab.click({ force: true })
    await expect(privateTab).toHaveAttribute('data-active', 'true')

    await page.evaluate(async () => {
      const environmentId = window.__store?.getState().settings?.activeRuntimeEnvironmentId
      if (!environmentId) {
        throw new Error('Private host was not selected')
      }
      await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
      await window.__store?.getState().readRuntimeHostStatusSnapshots()
    })
    const privateNotice = page.getByRole('status', { name: 'priv', exact: true })
    await expect(privateNotice).toContainText('Disconnected')
    await expect(privateTrigger.getByText('· Disconnected')).toHaveClass(/text-destructive/)
    await privateNotice
      .getByRole('button', { name: 'Reconnect', exact: true })
      .click({ force: true })
    await expect(privateNotice).toBeHidden()
    await expect(privateTrigger).toHaveText('priv')

    await privateTrigger.press('ArrowDown')
    await expect(page.getByRole('menuitemradio', { name: 'priv', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page
      .getByRole('menuitemradio', { name: 'Local desktop', exact: true })
      .click({ force: true })
    const localTrigger = page.getByRole('button', {
      name: 'Remote Hosts: Local desktop',
      exact: true
    })
    await expect(localTrigger).toBeVisible()
    await expect(localTrigger).toBeEnabled()
    await expect(workTab).toBeHidden()
    await expect(privateTab).toBeHidden()
    await expect(sidebar.getByText(path.basename(privateRepoPath), { exact: true })).toBeHidden()
    await expect(sidebar.getByText(path.basename(testRepoPath), { exact: true })).toBeHidden()
    await localTrigger.press('ArrowDown')
    await page.getByRole('menuitemradio', { name: 'work', exact: true }).click({ force: true })
    await expect(workTrigger).toBeVisible()
    await expect(workTrigger).toBeEnabled()
    await expect(workTab).toBeVisible()
    await expect(workTab).toHaveAttribute('data-active', 'true')
    await expect(privateTab).toBeHidden()
    await expect(sidebar.getByText(path.basename(testRepoPath), { exact: true })).toBeVisible()
    await expect(sidebar.getByText(path.basename(privateRepoPath), { exact: true })).toBeHidden()

    await workTrigger.press('ArrowDown')
    await privateRadio.click({ force: true })
    await expect(privateTrigger).toBeEnabled()
    await expect(sidebar.getByText(path.basename(privateRepoPath), { exact: true })).toBeVisible()
    await expect(privateTab).toBeVisible()
    await expect(privateTab).toHaveAttribute('data-active', 'true')
    await expect(workTab).toBeHidden()
    await privateHost.dispose()
    privateHost = null
    await expect(privateNotice).toContainText(/Reconnecting|Disconnected/)
    await privateTrigger.press('ArrowDown')
    await expect(privateRadio).toContainText(/Reconnecting|Disconnected/)
    await expect(privateRadio).toHaveAttribute('aria-disabled', 'true')
    await expect(privateRow.getByRole('menuitem', { name: 'Reconnect', exact: true })).toBeVisible()
    await expect(privateRadio).toHaveAttribute('aria-checked', 'true')
    await expect(privateTrigger).toContainText('priv')
    await expect(privateTrigger).toContainText(/· (Reconnecting|Disconnected)/)
    await page.getByRole('menuitemradio', { name: 'work', exact: true }).click({ force: true })
    await expect(workTrigger).toBeEnabled()
    await expect(privateNotice).toBeHidden()
    await expect(sidebar.getByText(path.basename(testRepoPath), { exact: true })).toBeVisible()
  } finally {
    await client?.dispose()
    await privateHost?.dispose()
    rmSync(privateRepoPath, { recursive: true, force: true })
  }
})
