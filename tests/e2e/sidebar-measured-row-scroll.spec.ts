import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { runProcess } from '../../src/shared/child-process/run-process'

test.use({ seedTestRepo: false })

type SidebarFixture = {
  groupId: string
  collapsedRepoId: string
  expandedRepoId: string
  worktreeId: string
}

async function readGeometry(page: Page, fixture: SidebarFixture) {
  return page.evaluate((target) => {
    const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
    const group = scroller?.querySelector<HTMLElement>(
      `[data-project-group-header-id="${target.groupId}"]`
    )
    const collapsed = scroller?.querySelector<HTMLElement>(
      `[data-repo-header-id="${target.collapsedRepoId}"]`
    )
    const expanded = scroller?.querySelector<HTMLElement>(
      `[data-repo-header-id="${target.expandedRepoId}"]`
    )
    const card = Array.from(
      scroller?.querySelectorAll<HTMLElement>('[data-worktree-id]') ?? []
    ).find((element) => element.dataset.worktreeId === target.worktreeId)
    if (!scroller || !group || !collapsed || !expanded || !card) {
      throw new Error('Expected fixture sidebar rows to be mounted')
    }
    const groupBounds = group.getBoundingClientRect()
    const hit = document.elementFromPoint(
      groupBounds.left + groupBounds.width / 2,
      groupBounds.top + groupBounds.height / 2
    )
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      groupUnobscured: group.contains(hit),
      collapsedGap: collapsed.getBoundingClientRect().top - groupBounds.bottom,
      expandedGap: expanded.getBoundingClientRect().top - collapsed.getBoundingClientRect().bottom,
      cardHeight: card.getBoundingClientRect().height
    }
  }, fixture)
}

async function settledGeometry(page: Page, fixture: SidebarFixture) {
  let previous = ''
  let stableSamples = 0
  await expect
    .poll(
      async () => {
        const signature = JSON.stringify(await readGeometry(page, fixture))
        stableSamples = signature === previous ? stableSamples + 1 : 0
        previous = signature
        return stableSamples
      },
      { intervals: [50] }
    )
    .toBeGreaterThanOrEqual(2)
  return readGeometry(page, fixture)
}

test('keeps a collapsed group visible when an idle card below it grows', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1200, height: 900 })
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-sidebar-measured-row-')))
  registerPostElectronShutdownCleanup(async () => {
    rmSync(root, { recursive: true, force: true })
  })
  const paths = ['group-member', 'LaunchStack', 'ai-platform'].map((name) => path.join(root, name))
  for (const repoPath of paths) {
    mkdirSync(repoPath)
    writeFileSync(path.join(repoPath, 'seed.txt'), 'seed\n')
    for (const args of [
      ['init'],
      ['add', '.'],
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'seed'
      ]
    ]) {
      const result = await runProcess({ program: 'git', args, cwd: repoPath, timeoutMs: 10_000 })
      expect(result.code, result.stderr).toBe(0)
    }
  }

  const fixture = await orcaPage.evaluate(async (repoPaths): Promise<SidebarFixture> => {
    const store = window.__store!
    for (const repoPath of repoPaths) {
      await window.api.repos.add({ path: repoPath })
    }
    await store.getState().awaitLocalRepoCatalogSettlement()
    const repos = repoPaths.map((repoPath) => {
      const repo = store.getState().repos.find((candidate) => candidate.path === repoPath)
      if (!repo) {
        throw new Error(`Fixture repo was not registered: ${repoPath}`)
      }
      return repo
    })
    for (const repo of repos) {
      await store.getState().fetchWorktrees(repo.id)
    }
    const [member, collapsed, expanded] = repos
    if (!member || !collapsed || !expanded) {
      throw new Error('Expected three fixture repos')
    }
    const group = await store.getState().createProjectGroup('Research gang')
    if (!group) {
      throw new Error('Fixture group was not created')
    }
    await store.getState().moveProjectToGroup(member.id, group.id)
    const state = store.getState()
    state.setGroupBy('repo')
    state.setProjectOrderBy('manual')
    const collapsedSetup = state.projectHostSetups.find((setup) => setup.repoId === collapsed.id)
    const worktree = state.worktreesByRepo[expanded.id]?.find((entry) => entry.isMainWorktree)
    if (!collapsedSetup || !worktree) {
      throw new Error('Fixture project setup or worktree is missing')
    }
    const collapsedGroups = [`project-group:${group.id}`, `project:${collapsedSetup.projectId}`]
    await window.api.ui.set({ groupBy: 'repo', collapsedGroups })
    store.setState({ collapsedGroups: new Set(collapsedGroups) })
    return {
      groupId: group.id,
      collapsedRepoId: collapsed.id,
      expandedRepoId: expanded.id,
      worktreeId: worktree.id
    }
  }, paths)

  const sidebar = orcaPage.locator('[data-worktree-sidebar]')
  const group = sidebar.locator(`[data-project-group-header-id="${fixture.groupId}"]`)
  const collapsedRepo = sidebar.locator(`[data-repo-header-id="${fixture.collapsedRepoId}"]`)
  const card = sidebar.locator(`[data-worktree-id=${JSON.stringify(fixture.worktreeId)}]`)
  await expect(group).toHaveCount(1)
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(collapsedRepo).toHaveAttribute('aria-expanded', 'false')
  await expect(card).toHaveCount(1)
  const before = await settledGeometry(orcaPage, fixture)
  expect(before.groupUnobscured).toBe(true)
  expect(before.scrollTop).toBe(0)
  expect(before.scrollHeight).toBeLessThanOrEqual(before.clientHeight)
  expect(before.collapsedGap).toBeGreaterThan(0)
  expect(before.expandedGap).toBeGreaterThan(0)

  const beforePath = testInfo.outputPath('before-card-growth.png')
  await sidebar.screenshot({ path: beforePath })
  await testInfo.attach('before-card-growth', { path: beforePath, contentType: 'image/png' })

  // A real child drives ResizeObserver without changing group data or patching the virtualizer.
  await card.evaluate((element) => {
    const content = document.createElement('div')
    content.style.height = '50px'
    element.appendChild(content)
  })
  await expect
    .poll(async () => (await readGeometry(orcaPage, fixture)).cardHeight)
    .toBeCloseTo(before.cardHeight + 50, 0)
  const after = await settledGeometry(orcaPage, fixture)
  const afterPath = testInfo.outputPath('after-card-growth.png')
  await sidebar.screenshot({ path: afterPath })
  await testInfo.attach('after-card-growth', { path: afterPath, contentType: 'image/png' })

  expect(after.groupUnobscured).toBe(true)
  expect(after.scrollTop).toBe(0)
  expect(after.scrollHeight).toBeLessThanOrEqual(after.clientHeight)
  expect(after.collapsedGap).toBeCloseTo(before.collapsedGap, 0)
  expect(after.expandedGap).toBeCloseTo(before.expandedGap, 0)
  await expect(group).toHaveCount(1)
})
