import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const tempRoots: string[] = []
const CLEANUP_RETRY_COUNT = 6

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < CLEANUP_RETRY_COUNT; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === CLEANUP_RETRY_COUNT - 1) {
        throw error
      }
      // Why: Windows and WSL-backed git probes can release repo handles shortly
      // after the Electron fixture closes; retry to keep the smoke idempotent.
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
}

async function createGitRepo(prefix: string, repoName: string): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempRoots.push(rootPath)
  const repoPath = path.join(rootPath, repoName)
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: repoPath, stdio: 'pipe' })
  writeFileSync(path.join(repoPath, 'README.md'), `# ${repoName}\n`)
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath, stdio: 'pipe' })
  return repoPath
}

async function openRepoSettings(page: Page, repoId: string): Promise<void> {
  await page.evaluate((nextRepoId) => {
    const state = window.__store!.getState()
    state.setSettingsSearchQuery('')
    state.openSettingsTarget({ pane: 'repo', repoId: nextRepoId })
    state.openSettingsPage()
  }, repoId)
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLaterButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLaterButton.click()
  }
}

async function chooseProjectRuntime(
  page: Page,
  repoId: string,
  runtimeLabel: 'Windows' | 'WSL'
): Promise<void> {
  const section = page.locator(`[data-settings-section="repo-${repoId}"]`)
  await section.getByRole('radio', { name: runtimeLabel, exact: true }).click()
  const applyButton = section.getByRole('button', { name: 'Apply runtime change' })
  if (await applyButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await applyButton.click()
  }
}

test.afterAll(async () => {
  for (const root of tempRoots.splice(0)) {
    await removeTempRoot(root)
  }
})

test.describe('Windows project runtime smoke', () => {
  test('keeps a Windows-host project and WSL project available side by side', async ({
    orcaPage,
    testRepoPath
  }) => {
    test.skip(process.platform !== 'win32', 'Windows project runtime smoke requires Windows')
    await waitForSessionReady(orcaPage)

    const wsl = await orcaPage.evaluate(async () => ({
      available: await window.api.wsl.isAvailable(),
      distros: await window.api.wsl.listDistros()
    }))
    test.skip(!wsl.available || wsl.distros.length === 0, 'WSL distro is required for smoke')
    const wslDistro = wsl.distros[0]!
    const wslRepoPath = await createGitRepo('orca-e2e-project-runtime-', 'wsl-runtime-project')

    const smoke = await orcaPage.evaluate(
      async ({ hostRepoPath, wslRepoPath, wslDistro }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }

        await window.api.repos.add({ path: wslRepoPath })
        await store.getState().fetchRepos()
        const state = store.getState()
        const hostRepo = state.repos.find((repo) => repo.path === hostRepoPath)
        const wslRepo = state.repos.find((repo) => repo.path === wslRepoPath)
        if (!hostRepo || !wslRepo) {
          throw new Error('Expected host and WSL smoke repos to be loaded')
        }

        const hostProject = state.projects.find((project) =>
          project.sourceRepoIds.includes(hostRepo.id)
        )
        const wslProject = state.projects.find((project) =>
          project.sourceRepoIds.includes(wslRepo.id)
        )
        if (!hostProject || !wslProject) {
          throw new Error('Expected host and WSL smoke projects to be loaded')
        }

        await state.updateProject(hostProject.id, {
          localWindowsRuntimePreference: { kind: 'windows-host' }
        })
        await state.updateProject(wslProject.id, {
          localWindowsRuntimePreference: { kind: 'wsl', distro: wslDistro }
        })

        const hostWorktrees = await window.api.worktrees.listDetected({ repoId: hostRepo.id })
        const wslWorktrees = await window.api.worktrees.listDetected({ repoId: wslRepo.id })
        return {
          hostRepoId: hostRepo.id,
          wslRepoId: wslRepo.id,
          wslDistro,
          hostWorktreeCount: hostWorktrees.worktrees.length,
          wslWorktreeCount: wslWorktrees.worktrees.length
        }
      },
      { hostRepoPath: testRepoPath, wslRepoPath, wslDistro }
    )

    expect(smoke.hostWorktreeCount).toBeGreaterThan(0)
    expect(smoke.wslWorktreeCount).toBeGreaterThan(0)

    await openRepoSettings(orcaPage, smoke.hostRepoId)
    const hostSection = orcaPage.locator(`[data-settings-section="repo-${smoke.hostRepoId}"]`)
    await expect(hostSection.getByText('Project Runtime')).toBeVisible()
    await expect(hostSection.getByText('This project runs on Windows.')).toBeVisible()
    await chooseProjectRuntime(orcaPage, smoke.hostRepoId, 'WSL')
    await expect(
      hostSection.getByText(`This project runs in ${smoke.wslDistro} via WSL.`)
    ).toBeVisible()
    const hostAfterWslUiSwitch = await orcaPage.evaluate((hostRepoId) => {
      const state = window.__store!.getState()
      const hostProject = state.projects.find((project) =>
        project.sourceRepoIds.includes(hostRepoId)
      )
      return hostProject?.localWindowsRuntimePreference
    }, smoke.hostRepoId)
    expect(hostAfterWslUiSwitch).toEqual({ kind: 'wsl', distro: smoke.wslDistro })

    await chooseProjectRuntime(orcaPage, smoke.hostRepoId, 'Windows')
    await expect(hostSection.getByText('This project runs on Windows.')).toBeVisible()
    const hostAfterWindowsUiSwitch = await orcaPage.evaluate((hostRepoId) => {
      const state = window.__store!.getState()
      const hostProject = state.projects.find((project) =>
        project.sourceRepoIds.includes(hostRepoId)
      )
      return hostProject?.localWindowsRuntimePreference
    }, smoke.hostRepoId)
    expect(hostAfterWindowsUiSwitch).toEqual({ kind: 'windows-host' })

    await openRepoSettings(orcaPage, smoke.wslRepoId)
    const wslSection = orcaPage.locator(`[data-settings-section="repo-${smoke.wslRepoId}"]`)
    await expect(wslSection.getByText('Project Runtime')).toBeVisible()
    await expect(
      wslSection.getByText(`This project runs in ${smoke.wslDistro} via WSL.`)
    ).toBeVisible()

    await orcaPage.evaluate(async (repoId) => {
      await window.api.repos.remove({ repoId })
    }, smoke.wslRepoId)
  })
})
