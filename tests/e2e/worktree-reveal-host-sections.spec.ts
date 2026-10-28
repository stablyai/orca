import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { attachRepoAndOpenTerminal } from './helpers/orca-restart'
import { evaluatePolled } from './helpers/page-evaluate-polled'
import { launchWithUnreachableSshWorkspaces } from './helpers/seeded-ssh-workspaces'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../src/shared/execution-host'

const sections = [
  { groupBy: 'none', key: 'pinned', label: 'Pinned', pinned: true },
  { groupBy: 'none', key: 'all', label: 'All', pinned: false },
  {
    groupBy: 'workspace-status',
    key: 'workspace-status:in-progress',
    label: 'In progress',
    pinned: false
  },
  { groupBy: 'pr-status', key: 'pr:in-progress', label: 'In progress', pinned: false }
] as const

/** Pins through main and waits for its answer. */
async function pinWorkspace(
  page: Page,
  worktreeId: string,
  isPinned: boolean,
  executionHostId: ExecutionHostId
): Promise<void> {
  await evaluatePolled(
    page,
    async (args) => {
      const written = await window.__store!.getState().updateWorktreeMeta(
        args.worktreeId,
        { isPinned: args.isPinned },
        {
          executionHostId: args.executionHostId
        }
      )
      if (!written.ok) {
        throw new Error(`Pinning failed: ${written.error}`)
      }
    },
    { worktreeId, isPinned, executionHostId }
  )
}

/** A desktop whose main holds a local workspace and one on another host, as a user's would. */
type RevealTopology = {
  page: Page
  local: string
  remote: string
  remoteHostId: ExecutionHostId
  setRemotePinned: (pinned: boolean) => Promise<void>
}

async function expectRevealsWithinHost(
  { page, local, remote, remoteHostId, setRemotePinned }: RevealTopology,
  testInfo: TestInfo
): Promise<void> {
  for (const section of sections) {
    for (const collapsedHost of [false, true]) {
      const scenario = `${section.key}-collapsed-${collapsedHost}`
      await test.step(scenario, async () => {
        await setRemotePinned(section.pinned)
        await pinWorkspace(page, local, section.pinned, 'local')
        // The window must show both pins before the reveal, or the row opens in the other section.
        await expect
          .poll(() =>
            page.evaluate(
              (ids) =>
                Object.values(window.__store!.getState().worktreesByRepo)
                  .flat()
                  .filter((worktree) => ids.includes(worktree.id))
                  .map((worktree) => worktree.isPinned),
              [local, remote]
            )
          )
          .toEqual([section.pinned, section.pinned])
        const collapsedGroups = [
          section.key,
          `${section.key}:host:${remoteHostId}`,
          ...(collapsedHost ? [`host:${remoteHostId}`] : [])
        ]
        await evaluatePolled(
          page,
          async ({ remote, remoteHostId, collapsedGroups, section }) => {
            const store = window.__store!
            const state = store.getState()
            const remoteRepoId = Object.values(state.worktreesByRepo)
              .flat()
              .find((worktree) => worktree.id === remote)!.repoId
            state.setActiveView('terminal')
            state.setSidebarOpen(true)
            state.setShowSleepingWorkspaces(true)
            state.setHideDefaultBranchWorkspace(false)
            state.setFilterRepoIds([])
            await window.api.ui.set({ groupBy: section.groupBy, collapsedGroups })
            store.setState({
              groupBy: section.groupBy,
              visibleWorkspaceHostIds: ['local', remoteHostId],
              workspaceHostScope: 'all',
              activeRepoId: remoteRepoId,
              activeWorktreeId: remote,
              activeWorkspaceKey: `worktree:${remote}`,
              activeWorkspaceExecutionHostId: remoteHostId,
              pendingRevealWorktree: null,
              collapsedGroups: new Set(collapsedGroups)
            })
          },
          { remote, remoteHostId, collapsedGroups, section }
        )
        const headers = page.getByRole('button', { name: new RegExp(`^${section.label}`) })
        const localRow = page.locator(
          `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(local)}]`
        )
        const remoteRow = page.locator(
          `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(remote)}]`
        )
        if (section.pinned || section.groupBy === 'workspace-status') {
          await expect(headers.first()).toHaveAttribute('aria-expanded', 'false')
        }
        await expect(localRow).toHaveCount(0)
        await expect(remoteRow).toHaveCount(0)
        await page.screenshot({
          path: testInfo.outputPath(`${scenario}-before-reveal.png`),
          clip: { x: 0, y: 170, width: 280, height: 500 }
        })
        await page.getByRole('button', { name: 'Reveal active workspace' }).click()
        await expect(remoteRow).toBeVisible()
        await expect(remoteRow).toHaveAttribute('data-scroll-reveal-highlight', 'true')
        await page.screenshot({
          path: testInfo.outputPath(`${scenario}-after-reveal.png`),
          clip: { x: 0, y: 170, width: 280, height: 500 }
        })
        await expect(headers).toHaveCount(2)
        if (section.pinned || section.groupBy === 'workspace-status') {
          await expect(headers.first()).toHaveAttribute('aria-expanded', 'false')
          await expect(headers.last()).toHaveAttribute('aria-expanded', 'true')
        }
        await expect(localRow).toHaveCount(0)

        await headers.last().click()
        await expect(remoteRow).toHaveCount(0)
        await page.evaluate((localId) => {
          const store = window.__store!
          const worktree = Object.values(store.getState().worktreesByRepo)
            .flat()
            .find((entry) => entry.id === localId)!
          store.setState({
            activeRepoId: worktree.repoId,
            activeWorktreeId: localId,
            activeWorkspaceKey: `worktree:${localId}`,
            activeWorkspaceExecutionHostId: 'local',
            pendingRevealWorktree: null
          })
        }, local)
        await page.getByRole('button', { name: 'Reveal active workspace' }).click()
        await expect(localRow).toBeVisible()
        if (section.pinned || section.groupBy === 'workspace-status') {
          await expect(headers.first()).toHaveAttribute('aria-expanded', 'true')
          await expect(headers.last()).toHaveAttribute('aria-expanded', 'false')
        }
        await expect(remoteRow).toHaveCount(0)
        // Finish the reveal and its persistence before resetting the next scenario.
        await expect
          .poll(() =>
            page.evaluate(async () => ({
              pendingRevealWorktree: window.__store!.getState().pendingRevealWorktree,
              collapsedGroups: [...window.__store!.getState().collapsedGroups].sort(),
              persistedCollapsedGroups: (await window.api.ui.get()).collapsedGroups?.sort()
            }))
          )
          .toEqual({
            pendingRevealWorktree: null,
            collapsedGroups: [`${section.key}:host:${remoteHostId}`],
            persistedCollapsedGroups: [`${section.key}:host:${remoteHostId}`]
          })
        await expect(localRow).toBeVisible()
        await expect(remoteRow).toHaveCount(0)
      })
    }
  }
}

test("reveals an unreachable SSH host's workspaces without expanding another host's section", async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const launched = await launchWithUnreachableSshWorkspaces(testInfo, testRepoPath, {
    label: 'Remote builder',
    workspaces: [{ name: 'feature', displayName: 'Remote workspace' }]
  })
  try {
    const { page, ssh, localWorktreeId } = launched
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const remote = ssh.worktreeIds.feature!
    await expectRevealsWithinHost(
      {
        page,
        local: localWorktreeId,
        remote,
        remoteHostId: ssh.hostId,
        setRemotePinned: (isPinned) => pinWorkspace(page, remote, isPinned, ssh.hostId)
      },
      testInfo
    )
  } finally {
    await launched.dispose()
  }
})

test("reveals a paired server's workspaces without expanding another host's section", async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const serverRepo = testInfo.outputPath('server-repo')
  mkdirSync(serverRepo, { recursive: true })
  writeFileSync(path.join(serverRepo, 'README.md'), 'server repo\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: serverRepo, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('add', 'README.md')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')

  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'runtime' })
  try {
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'reveal-host-sections')
    try {
      const { page } = desktop
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await waitForSessionReady(page)
      const local = await attachRepoAndOpenTerminal(page, testRepoPath)
      await waitForStartupWorktreeRefresh(page)
      const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: serverRepo,
        kind: 'git'
      })
      const created = await host.client.call<{ worktree: { id: string } }>('worktree.create', {
        repo: `id:${added.result.repo.id}`,
        name: 'feature',
        displayName: 'Remote workspace',
        setupDecision: 'skip'
      })
      const remote = created.result.worktree.id
      const remoteHostId = toRuntimeExecutionHostId(desktop.environmentId)
      await expectRevealsWithinHost(
        {
          page,
          local,
          remote,
          remoteHostId,
          setRemotePinned: async (isPinned) => {
            await host.client.call('worktree.set', { worktree: `id:${remote}`, isPinned })
          }
        },
        testInfo
      )
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
