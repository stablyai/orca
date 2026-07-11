import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'

const GROUP_NAMES = [
  'E2E Manual Group Alpha',
  'E2E Manual Group Bravo',
  'E2E Manual Group Charlie',
  'E2E Manual Group Delta'
] as const

const PROJECT_NAMES = [
  'e2e-manual-project-alpha',
  'e2e-manual-project-bravo',
  'e2e-manual-project-charlie'
] as const

const tempRoots: string[] = []

type SeededProjectGroupSortScenario = {
  alphaId: string
  bravoId: string
  charlieId: string
  deltaId: string
}

type SeededProjectHeaderSortScenario = {
  alphaId: string
  bravoId: string
  charlieId: string
}

function initializeGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: repoPath, stdio: 'pipe' })
  writeFileSync(path.join(repoPath, 'README.md'), `# ${path.basename(repoPath)}\n`)
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'pipe' })
}

async function createProjectHeaderSortFixture(): Promise<string[]> {
  // Why: match the app's canonical repo.path on macOS, where os.tmpdir()
  // can resolve through /var -> /private/var.
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-project-sort-')))
  tempRoots.push(root)
  const repoPaths = PROJECT_NAMES.map((name) => path.join(root, name))
  for (const repoPath of repoPaths) {
    initializeGitRepo(repoPath)
  }
  return repoPaths
}

async function seedProjectHeaderSortScenario(
  page: Page,
  repoPaths: readonly string[]
): Promise<SeededProjectHeaderSortScenario> {
  return page.evaluate(async (paths) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    for (const repoPath of paths) {
      await window.api.repos.add({ path: repoPath })
    }

    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('repo')
    state.setProjectOrderBy('manual')
    // Why: repos.add broadcasts repos:changed, which schedules background
    // fetchRepos() calls; those bump reposFetchGeneration and can make our awaited
    // fetchRepos() drop its own complete result as superseded (#7020), leaving the
    // store transiently missing the last-added repo. Re-fetch until every seeded
    // repo is present rather than racing a single fetch (converges once the adds
    // stop firing repos:changed).
    const findSeededRepos = () =>
      paths.map((repoPath) =>
        store.getState().repos.find((candidate) => candidate.path === repoPath)
      )
    let repos = findSeededRepos()
    const deadline = Date.now() + 10_000
    while (repos.some((repo) => !repo) && Date.now() < deadline) {
      await state.fetchRepos()
      repos = findSeededRepos()
      if (repos.every((repo) => repo)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const resolvedRepos = repos.map((repo, index) => {
      if (!repo) {
        throw new Error(`Expected project repo to be loaded: ${paths[index]}`)
      }
      return repo
    })

    for (const repo of resolvedRepos) {
      await store.getState().fetchWorktrees(repo.id)
    }

    return {
      alphaId: resolvedRepos[0]!.id,
      bravoId: resolvedRepos[1]!.id,
      charlieId: resolvedRepos[2]!.id
    }
  }, repoPaths)
}

async function seedDuplicateTabOrderProjectGroups(
  page: Page
): Promise<SeededProjectGroupSortScenario> {
  return page.evaluate(async (groupNames) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('repo')
    state.setProjectOrderBy('manual')

    const groups = []
    for (const name of groupNames) {
      const created = await state.createProjectGroup(name)
      if (!created) {
        throw new Error(`Failed to create Project Group: ${name}`)
      }
      // Why: existing profiles can have several groups with the same legacy rank;
      // the drag must still be able to insert one between its siblings.
      await state.updateProjectGroup(created.id, { tabOrder: 0 })
      groups.push(created)
    }

    return {
      alphaId: groups[0]!.id,
      bravoId: groups[1]!.id,
      charlieId: groups[2]!.id,
      deltaId: groups[3]!.id
    }
  }, GROUP_NAMES)
}

async function getProjectHeaderOrder(
  page: Page,
  projectIds: SeededProjectHeaderSortScenario
): Promise<string[]> {
  const expectedIds = new Set(Object.values(projectIds))
  return page.locator('[data-worktree-sidebar] [data-repo-header-id]').evaluateAll(
    (elements, ids) =>
      elements
        .map((element) => ({
          id: element.getAttribute('data-repo-header-id') ?? '',
          top: element.getBoundingClientRect().top
        }))
        .filter((entry) => ids.includes(entry.id))
        .sort((left, right) => left.top - right.top)
        .map((entry) => entry.id),
    [...expectedIds]
  )
}

async function getProjectGroupHeaderOrder(
  page: Page,
  groupIds: SeededProjectGroupSortScenario
): Promise<string[]> {
  const expectedIds = new Set(Object.values(groupIds))
  return page.locator('[data-worktree-sidebar] [data-project-group-header-id]').evaluateAll(
    (elements, ids) =>
      elements
        .map((element) => ({
          id: element.getAttribute('data-project-group-header-id') ?? '',
          top: element.getBoundingClientRect().top
        }))
        .filter((entry) => ids.includes(entry.id))
        .sort((left, right) => left.top - right.top)
        .map((entry) => entry.id),
    [...expectedIds]
  )
}

async function dragProjectBefore(args: {
  page: Page
  draggedProjectId: string
  targetProjectId: string
}): Promise<void> {
  const source = args.page.locator(`[data-repo-header-id="${args.draggedProjectId}"]`)
  const target = args.page.locator(`[data-repo-header-id="${args.targetProjectId}"]`)
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) {
    throw new Error('Project header bounding box was not available')
  }

  await args.page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await args.page.mouse.down()
  await args.page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 3, { steps: 8 })
  await args.page.mouse.up()
}

async function dragProjectIntoProjectBody(args: {
  page: Page
  draggedProjectId: string
  targetProjectId: string
}): Promise<void> {
  const source = args.page.locator(`[data-repo-header-id="${args.draggedProjectId}"]`)
  const targetHeader = args.page.locator(`[data-repo-header-id="${args.targetProjectId}"]`)
  await source.scrollIntoViewIfNeeded()
  await targetHeader.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetHeaderBox = await targetHeader.boundingBox()
  if (!sourceBox || !targetHeaderBox) {
    throw new Error('Project body drag bounding box was not available')
  }

  await args.page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await args.page.mouse.down()
  await args.page.mouse.move(
    targetHeaderBox.x + targetHeaderBox.width / 2,
    targetHeaderBox.y + targetHeaderBox.height * 0.75,
    { steps: 4 }
  )
  await args.page.mouse.move(
    targetHeaderBox.x + targetHeaderBox.width / 2,
    targetHeaderBox.y + targetHeaderBox.height + 32,
    { steps: 8 }
  )
  await args.page.mouse.up()
}

async function dragProjectGroupBefore(args: {
  page: Page
  draggedGroupId: string
  targetGroupId: string
}): Promise<void> {
  const source = args.page.locator(`[data-project-group-header-id="${args.draggedGroupId}"]`)
  const target = args.page.locator(`[data-project-group-header-id="${args.targetGroupId}"]`)
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) {
    throw new Error('Project Group header bounding box was not available')
  }

  await args.page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await args.page.mouse.down()
  await args.page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 3, { steps: 8 })
  await args.page.mouse.up()
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test.describe('Project Group manual sorting', () => {
  test('dragging a project header body reorders the visible project headers', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const repoPaths = await createProjectHeaderSortFixture()
    const projects = await seedProjectHeaderSortScenario(orcaPage, repoPaths)

    await expect
      .poll(() => getProjectHeaderOrder(orcaPage, projects), {
        timeout: 12_000,
        message: 'Project headers did not render in manual order'
      })
      .toEqual([projects.alphaId, projects.bravoId, projects.charlieId])

    await dragProjectBefore({
      page: orcaPage,
      draggedProjectId: projects.charlieId,
      targetProjectId: projects.bravoId
    })

    await expect
      .poll(() => getProjectHeaderOrder(orcaPage, projects), {
        timeout: 12_000,
        message: 'Dragged project header body did not persist the requested visible order'
      })
      .toEqual([projects.alphaId, projects.charlieId, projects.bravoId])
  })

  test('dropping a project over another project body does not reorder projects', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const repoPaths = await createProjectHeaderSortFixture()
    const projects = await seedProjectHeaderSortScenario(orcaPage, repoPaths)

    await expect
      .poll(() => getProjectHeaderOrder(orcaPage, projects), {
        timeout: 12_000,
        message: 'Project headers did not render in manual order'
      })
      .toEqual([projects.alphaId, projects.bravoId, projects.charlieId])

    await dragProjectIntoProjectBody({
      page: orcaPage,
      draggedProjectId: projects.alphaId,
      targetProjectId: projects.bravoId
    })

    await expect
      .poll(() => getProjectHeaderOrder(orcaPage, projects), {
        timeout: 12_000,
        message: 'Dropping on a project body should not persist a project reorder'
      })
      .toEqual([projects.alphaId, projects.bravoId, projects.charlieId])
  })

  test('dragging a duplicate-ranked Project Group header reorders the visible headers', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const groups = await seedDuplicateTabOrderProjectGroups(orcaPage)

    await expect
      .poll(() => getProjectGroupHeaderOrder(orcaPage, groups), {
        timeout: 12_000,
        message: 'Project Group headers did not render in duplicate-rank name order'
      })
      .toEqual([groups.alphaId, groups.bravoId, groups.charlieId, groups.deltaId])

    await dragProjectGroupBefore({
      page: orcaPage,
      draggedGroupId: groups.deltaId,
      targetGroupId: groups.charlieId
    })

    await expect
      .poll(() => getProjectGroupHeaderOrder(orcaPage, groups), {
        timeout: 12_000,
        message: 'Dragged Project Group header did not persist the requested visible order'
      })
      .toEqual([groups.alphaId, groups.bravoId, groups.deltaId, groups.charlieId])
  })
})
