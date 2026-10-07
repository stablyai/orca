import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import {
  getFirstWslDistro,
  useWslRuntimeForActiveProject as configureWslRuntimeForActiveProject
} from './wsl-golden-stub-agent'

export async function prepareInlineImageRuntime(
  page: Page,
  runtime: 'native' | 'wsl'
): Promise<void> {
  if (process.platform !== 'win32') {
    if (runtime === 'wsl') {
      throw new Error('WSL image verification requires Windows')
    }
    return
  }
  if (runtime === 'wsl') {
    const distro = await getFirstWslDistro(page)
    if (!distro) {
      throw new Error('WSL image verification requires an installed distro')
    }
    await configureWslRuntimeForActiveProject(page, distro)
  } else {
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettings({ terminalWindowsShell: 'powershell.exe' })
    })
  }
  const tabId = await page.evaluate(() => {
    const state = window.__store!.getState()
    const worktree = state.activeWorktreeId
    if (!worktree) {
      throw new Error('Missing image verification worktree')
    }
    const tab = state.createTab(worktree)
    window.__store!.getState().setActiveTab(tab.id)
    window.__store!.getState().setActiveTabType('terminal', worktree)
    return tab.id
  })
  await expect(page.locator(`[data-tab-id="${tabId}"] [data-shell-icon]`).first()).toHaveAttribute(
    'data-shell-icon',
    runtime === 'wsl' ? 'wsl.exe' : 'powershell.exe'
  )
}
