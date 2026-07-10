import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { SkillDiscoveryResult } from '../../src/shared/skills'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const CHECKLIST_TEXT = 'Onboarding checklist'

type SetupGuideFlashMonitor = {
  samples: number[]
  stop: () => number[]
}

test.describe('Setup guide sidebar entry', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('does not flash while completed setup waits for capability readiness', async ({
    electronApp,
    orcaPage
  }) => {
    await installBlockedCompletedCapabilityFakes(electronApp)
    await orcaPage.reload()
    await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    await waitForSessionReady(orcaPage)
    await seedCompletedSetupExceptCapabilityReadiness(orcaPage)

    await expect
      .poll(async () => getStoreState<boolean>(orcaPage, 'setupGuideSidebarDismissed'), {
        timeout: 5_000
      })
      .toBe(false)
    await expect(orcaPage.getByText(CHECKLIST_TEXT)).toHaveCount(0)

    await startSetupGuideFlashMonitor(orcaPage)

    await setActiveViewForFlashProbe(orcaPage, 'tasks')
    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('tasks')
    await orcaPage.waitForTimeout(500)

    await setActiveViewForFlashProbe(orcaPage, 'automations')
    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('automations')
    await orcaPage.waitForTimeout(500)

    await setActiveViewForFlashProbe(orcaPage, 'mobile')
    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('mobile')
    await orcaPage.waitForTimeout(500)

    const flashSamples = await stopSetupGuideFlashMonitor(orcaPage)
    expect(flashSamples, `setup guide sidebar flashed at ${flashSamples.join(', ')}`).toEqual([])

    // Unblock pending skill discovery IPC calls before teardown. Completion
    // after release is covered by the focused progress unit tests.
    await releaseBlockedSkillDiscovery(electronApp)
    await orcaPage.evaluate(() => {
      window.dispatchEvent(new CustomEvent('orca:installed-agent-skills-changed'))
    })
  })
})

async function setActiveViewForFlashProbe(
  page: Page,
  view: 'tasks' | 'automations' | 'mobile'
): Promise<void> {
  await page.evaluate((nextView) => {
    // Why: this spec monitors setup-guide visibility during view transitions;
    // CI pointer stability over sidebar nav is covered by separate nav tests.
    window.__store?.getState().setActiveView(nextView)
  }, view)
}

async function installBlockedCompletedCapabilityFakes(
  electronApp: ElectronApplication
): Promise<void> {
  await evaluateInElectronMainWithNavigationRetry(electronApp, ({ ipcMain }) => {
    type SetupGuideSkillDiscoveryState = {
      blocked: boolean
      resolvers: (() => void)[]
    }
    const globalWithState = globalThis as typeof globalThis & {
      __setupGuideSkillDiscovery?: SetupGuideSkillDiscoveryState
    }
    globalWithState.__setupGuideSkillDiscovery = {
      blocked: true,
      resolvers: []
    }
    const waitForSkillDiscoveryRelease = async (): Promise<void> => {
      const state = globalWithState.__setupGuideSkillDiscovery
      if (!state?.blocked) {
        return
      }
      await new Promise<void>((resolve) => {
        state.resolvers.push(resolve)
      })
    }
    const makeSkill = (name: string, id: string): SkillDiscoveryResult['skills'][number] => ({
      id,
      name,
      description: null,
      providers: ['agent-skills'],
      sourceKind: 'home',
      sourceLabel: 'E2E skill home',
      rootPath: '/tmp/orca-e2e-skills',
      directoryPath: `/tmp/orca-e2e-skills/${name}`,
      skillFilePath: `/tmp/orca-e2e-skills/${name}/SKILL.md`,
      installed: true,
      fileCount: 1,
      updatedAt: 1
    })

    ipcMain.removeHandler('skills:discover')
    ipcMain.handle('skills:discover', async (): Promise<SkillDiscoveryResult> => {
      await waitForSkillDiscoveryRelease()
      return {
        skills: [
          makeSkill('orca-cli', 'e2e-orca-cli'),
          makeSkill('computer-use', 'e2e-computer-use'),
          makeSkill('orchestration', 'e2e-orchestration')
        ],
        sources: [],
        scannedAt: Date.now()
      }
    })

    ipcMain.removeHandler('computerUsePermissions:getStatus')
    ipcMain.handle('computerUsePermissions:getStatus', async () => ({
      platform: process.platform,
      helperAppPath: null,
      helperUnavailableReason: 'e2e-unavailable',
      permissions: []
    }))

    ipcMain.removeHandler('hooks:check')
    ipcMain.handle('hooks:check', async () => ({
      status: 'ok',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    }))
  })
}

async function releaseBlockedSkillDiscovery(electronApp: ElectronApplication): Promise<void> {
  await evaluateInElectronMainWithNavigationRetry(electronApp, () => {
    const globalWithState = globalThis as typeof globalThis & {
      __setupGuideSkillDiscovery?: {
        blocked: boolean
        resolvers: (() => void)[]
      }
    }
    const state = globalWithState.__setupGuideSkillDiscovery
    if (!state) {
      return
    }
    state.blocked = false
    for (const resolve of state.resolvers.splice(0)) {
      resolve()
    }
  })
}

async function evaluateInElectronMainWithNavigationRetry<T>(
  electronApp: ElectronApplication,
  callback: Parameters<ElectronApplication['evaluate']>[0]
): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return (await electronApp.evaluate(callback)) as T
    } catch (error) {
      lastError = error
      if (!(error instanceof Error) || !error.message.includes('Execution context was destroyed')) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError
}

async function seedCompletedSetupExceptCapabilityReadiness(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const existingRepo = state.repos[0] ?? {
      id: 'setup-guide-repo-a',
      path: '/tmp/setup-guide-repo-a',
      displayName: 'setup-guide-repo-a',
      badgeColor: '#64748b',
      addedAt: Date.now(),
      kind: 'git'
    }
    const primaryRepo = {
      ...existingRepo,
      kind: 'git',
      hookSettings: {
        mode: 'auto',
        commandSourcePolicy: 'local-only',
        scripts: { setup: 'echo setup', archive: '' }
      }
    }
    const secondaryRepo = {
      ...primaryRepo,
      id: 'setup-guide-repo-b',
      path: `${primaryRepo.path}-b`,
      displayName: 'setup-guide-repo-b'
    }
    const makeWorktree = (args: {
      id: string
      repoId: string
      path: string
      displayName: string
      isMainWorktree: boolean
    }) => ({
      id: args.id,
      repoId: args.repoId,
      path: args.path,
      displayName: args.displayName,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: Date.now(),
      head: '0000000000000000000000000000000000000000',
      branch: args.displayName,
      isBare: false,
      isMainWorktree: args.isMainWorktree
    })
    const mainWorktree = makeWorktree({
      id: 'setup-guide-main-worktree',
      repoId: primaryRepo.id,
      path: primaryRepo.path,
      displayName: 'main',
      isMainWorktree: true
    })
    const secondaryWorktree = makeWorktree({
      id: 'setup-guide-secondary-worktree',
      repoId: primaryRepo.id,
      path: `${primaryRepo.path}-secondary`,
      displayName: 'setup-guide-secondary',
      isMainWorktree: false
    })

    store.setState({
      settings: {
        ...state.settings,
        activeRuntimeEnvironmentId: null,
        defaultTuiAgent: 'codex',
        notifications: {
          ...state.settings?.notifications,
          enabled: true,
          agentTaskComplete: true
        }
      },
      preflightStatus: {
        git: { installed: true },
        gh: { installed: true, authenticated: true },
        glab: { installed: false, authenticated: false },
        bitbucket: { configured: false, authenticated: false, account: null },
        azureDevOps: {
          configured: false,
          authenticated: false,
          account: null,
          baseUrl: null,
          tokenConfigured: false
        },
        gitea: {
          configured: false,
          authenticated: false,
          account: null,
          baseUrl: null,
          tokenConfigured: false
        }
      },
      preflightStatusChecked: true,
      preflightStatusLoading: false,
      linearStatus: { connected: false, viewer: null },
      linearStatusChecked: true,
      repos: [primaryRepo, secondaryRepo],
      activeRepoId: primaryRepo.id,
      worktreesByRepo: {
        [primaryRepo.id]: [mainWorktree, secondaryWorktree],
        [secondaryRepo.id]: [
          makeWorktree({
            id: 'setup-guide-secondary-repo-main-worktree',
            repoId: secondaryRepo.id,
            path: secondaryRepo.path,
            displayName: 'main',
            isMainWorktree: true
          })
        ]
      },
      tabsByWorktree: {
        [secondaryWorktree.id]: [{ id: 'setup-guide-terminal-tab', title: 'Terminal' }]
      },
      terminalLayoutsByTabId: {
        'setup-guide-terminal-tab': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'setup-guide-left' },
            second: { type: 'leaf', leafId: 'setup-guide-right' }
          }
        }
      },
      setupGuideSidebarDismissed: false,
      persistedUIReady: true
    })
  })
  await page.waitForTimeout(250)
}

async function startSetupGuideFlashMonitor(page: Page): Promise<void> {
  await page.evaluate((text) => {
    const monitoredWindow = window as Window & {
      __setupGuideFlashMonitor?: SetupGuideFlashMonitor
    }
    monitoredWindow.__setupGuideFlashMonitor?.stop()

    const samples: number[] = []
    let rafId = 0
    const isChecklistVisible = (): boolean =>
      Array.from(document.querySelectorAll('button,[role="button"],a,div,span')).some((element) => {
        if (!element.textContent?.includes(text)) {
          return false
        }
        if (element.getClientRects().length === 0) {
          return false
        }
        const style = window.getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      })

    const record = (): void => {
      if (isChecklistVisible()) {
        samples.push(Math.round(performance.now()))
      }
    }
    const observer = new MutationObserver(record)
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    })
    const sampleFrame = (): void => {
      record()
      rafId = requestAnimationFrame(sampleFrame)
    }
    sampleFrame()

    monitoredWindow.__setupGuideFlashMonitor = {
      samples,
      stop: () => {
        cancelAnimationFrame(rafId)
        observer.disconnect()
        record()
        return samples
      }
    }
  }, CHECKLIST_TEXT)
}

async function stopSetupGuideFlashMonitor(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __setupGuideFlashMonitor?: SetupGuideFlashMonitor
        }
      ).__setupGuideFlashMonitor?.stop() ?? []
  )
}
