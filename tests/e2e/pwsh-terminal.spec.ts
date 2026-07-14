import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type PaneOutput = {
  ptyId: string | null
  text: string
}

type PowerShellProfileExpectation = {
  shellOverride: 'powershell.exe' | 'pwsh.exe'
  marker: string
  versionCheck: string
  executableName: 'powershell.exe' | 'pwsh.exe'
}

async function readPaneOutputs(page: Page, tabId: string): Promise<PaneOutput[]> {
  return page.evaluate((targetTabId) => {
    const manager = window.__paneManagers?.get(targetTabId)
    return (
      manager?.getPanes().map((pane) => ({
        ptyId: pane.container.dataset.ptyId ?? null,
        text: pane.serializeAddon?.serialize?.({ scrollback: 200 }) ?? ''
      })) ?? []
    )
  }, tabId)
}

async function addAndActivateRepo(page: Page, repoPath: string): Promise<void> {
  const repoId = await page.evaluate(async (pathToRepo) => {
    const repo = await window.__store?.getState().addRepoPath(pathToRepo)
    if (!repo) {
      throw new Error(`PowerShell 7 E2E repo not found: ${pathToRepo}`)
    }
    await window.__store?.getState().updateRepo(repo.id, {
      externalWorktreeVisibility: 'show'
    })
    return repo.id
  }, repoPath)

  await expect
    .poll(
      () =>
        page.evaluate(async (targetRepoId) => {
          const state = window.__store?.getState()
          if (!state) {
            return 0
          }
          await state.fetchWorktrees(targetRepoId)
          return state.worktreesByRepo[targetRepoId]?.length ?? 0
        }, repoId),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0)

  await page.evaluate((targetRepoId) => {
    const state = window.__store?.getState()
    const worktree = state?.worktreesByRepo[targetRepoId]?.[0]
    if (!state || !worktree) {
      throw new Error(`PowerShell 7 E2E worktree not found: ${targetRepoId}`)
    }
    state.setActiveRepo(targetRepoId)
    state.setActiveWorktree(worktree.id)
  }, repoId)
}

async function assertPowerShellProfileAndSplit(
  page: Page,
  expectation: PowerShellProfileExpectation
): Promise<string> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        if (!state || !worktreeId) {
          return null
        }
        return (state.tabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === state.activeTabId)
          ?.shellOverride
      })
    )
    .toBe(expectation.shellOverride)

  await waitForActiveTerminalManager(page)
  const initialSnapshot = await waitForPaneIdentitySnapshot(page, 1)
  const initialPtyId = initialSnapshot.panes[0]?.ptyId
  if (!initialPtyId) {
    throw new Error(`${expectation.marker} terminal did not receive its initial PTY`)
  }
  await execInTerminal(
    page,
    initialPtyId,
    `$isExpected = ${expectation.versionCheck}; Write-Output ("${expectation.marker}_PRIMARY={0}:{1}" -f $isExpected, (Get-Process -Id $PID).Path)`
  )
  await waitForTerminalOutput(page, `${expectation.marker}_PRIMARY=True:`)

  await splitActiveTerminalPane(page, 'vertical')
  const splitSnapshot = await waitForPaneIdentitySnapshot(page, 2)
  for (const [index, pane] of splitSnapshot.panes.entries()) {
    if (!pane.ptyId) {
      throw new Error(`${expectation.marker} split pane ${index} did not receive a PTY`)
    }
    await execInTerminal(
      page,
      pane.ptyId,
      `$isExpected = ${expectation.versionCheck}; Write-Output ("${expectation.marker}_SPLIT_${index}={0}:{1}" -f $isExpected, (Get-Process -Id $PID).Path)`
    )
  }

  const executablePattern = expectation.executableName.replace('.', '\\.')
  await expect
    .poll(async () => readPaneOutputs(page, splitSnapshot.tabId), { timeout: 15_000 })
    .toEqual(
      expect.arrayContaining(
        splitSnapshot.panes.map((_, index) =>
          expect.objectContaining({
            text: expect.stringMatching(
              new RegExp(`${expectation.marker}_SPLIT_${index}=True:.*${executablePattern}`, 'i')
            )
          })
        )
      )
    )

  return splitSnapshot.tabId
}

test.use({ seedTestRepo: false })

test('PowerShell profiles launch their exact versions and keep them across splits', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const canRunPwshProfile = await orcaPage.evaluate(async () => ({
    isWindows: navigator.userAgent.includes('Windows'),
    pwshAvailable: await window.api.pwsh.isAvailable()
  }))
  test.skip(
    !canRunPwshProfile.isWindows || !canRunPwshProfile.pwshAvailable,
    'PowerShell 7 profile E2E requires pwsh on a Windows host'
  )
  await addAndActivateRepo(orcaPage, testRepoPath)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const newTabButton = orcaPage.locator('button[aria-haspopup="menu"]').filter({
    has: orcaPage.locator('svg.lucide-plus')
  })
  await newTabButton.click({ force: true })
  const powershellMenuItem = orcaPage
    .getByRole('menuitem')
    .filter({ hasText: 'PowerShell', hasNotText: 'PowerShell 7+' })
  await expect(powershellMenuItem).toBeVisible({ timeout: 15_000 })
  await powershellMenuItem.click({ force: true })

  await assertPowerShellProfileAndSplit(orcaPage, {
    shellOverride: 'powershell.exe',
    marker: 'ORCA_POWERSHELL5',
    versionCheck:
      "$PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSEdition -eq 'Desktop'",
    executableName: 'powershell.exe'
  })

  await newTabButton.click({ force: true })
  const pwshMenuItem = orcaPage.getByRole('menuitem').filter({ hasText: 'PowerShell 7+' })
  await expect(pwshMenuItem).toBeVisible({ timeout: 15_000 })
  await orcaPage.screenshot({ path: testInfo.outputPath('pwsh7-new-terminal-menu.png') })
  if (!(await pwshMenuItem.isVisible())) {
    await newTabButton.click({ force: true })
    await expect(pwshMenuItem).toBeVisible()
  }
  await pwshMenuItem.click({ force: true })

  await assertPowerShellProfileAndSplit(orcaPage, {
    shellOverride: 'pwsh.exe',
    marker: 'ORCA_POWERSHELL7',
    versionCheck: "$PSVersionTable.PSVersion.Major -ge 7 -and $PSVersionTable.PSEdition -eq 'Core'",
    executableName: 'pwsh.exe'
  })

  await orcaPage
    .locator('.pane-split')
    .filter({ has: orcaPage.locator('.xterm') })
    .last()
    .screenshot({ path: testInfo.outputPath('pwsh7-split-terminals.png') })

  await orcaPage.evaluate(async () => {
    const store = window.__store
    const settings = store?.getState().settings
    if (!store || !settings) {
      throw new Error('Settings are unavailable for the PowerShell 7 E2E check')
    }
    const nextSettings = await window.api.settings.set({
      ...settings,
      terminalWindowsShell: 'powershell.exe'
    })
    store.setState({ settings: nextSettings })
    const state = store.getState()
    state.openSettingsTarget({ pane: 'terminal', repoId: null })
    state.openSettingsPage()
  })
  const defaultShellGroup = orcaPage.getByRole('radiogroup', { name: /Default Shell|기본 쉘/ })
  const pwshSettingsRadio = defaultShellGroup.getByRole('radio', { name: 'PowerShell 7+' })
  await expect(pwshSettingsRadio).toBeVisible({ timeout: 15_000 })
  await pwshSettingsRadio.click()
  await expect(pwshSettingsRadio).toBeChecked()
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__store?.getState().settings?.terminalWindowsShell ?? null)
    )
    .toBe('pwsh.exe')
  await defaultShellGroup.screenshot({ path: testInfo.outputPath('pwsh7-settings.png') })
})
