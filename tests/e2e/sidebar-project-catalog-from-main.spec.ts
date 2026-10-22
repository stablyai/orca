/**
 * The desktop sidebar's projects and project groups come from main's feed (ORCA_SIDEBAR_INPUTS=main):
 * each create, rename, reorder, move and delete shows once main publishes it, and a restored
 * catalog draws its headers once.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { WebContents } from 'electron'
import { runProcess } from '@orca/process-host'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'
import { waitForSessionReady } from './helpers/store'

test.skip(!SIDEBAR_INPUTS_BUILD, 'the window reads main only in an ORCA_SIDEBAR_INPUTS=main build')
test.use({ seedTestRepo: false })

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __catalogHeaders?: () => string[]
    __catalogDraws?: { atInstall: boolean; states: string[][] }
  }
}

/** Runs in the window, serialized: each header in drawn order, a project with its group bucket. */
function installHeaderReader(): void {
  window.__catalogHeaders = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-worktree-sidebar] [data-repo-header-id], [data-worktree-sidebar] [data-project-group-header-id]'
      )
    ]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map((header) =>
        header.dataset.projectGroupHeaderId
          ? `group:${header.dataset.projectGroupHeaderId}:${header.textContent?.trim() ?? ''}`
          : `project:${header.dataset.repoHeaderId}@${header.dataset.repoHeaderBucket ?? ''}`
      )
}

/** Records every distinct header list the sidebar commits, from before its first draw. */
function recordHeaderDraws(): void {
  const read = (): string[] =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-worktree-sidebar] [data-repo-header-id], [data-worktree-sidebar] [data-project-group-header-id]'
      )
    ]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map(
        (header) =>
          header.dataset.projectGroupHeaderId ??
          `${header.dataset.repoHeaderId}@${header.dataset.repoHeaderBucket ?? ''}`
      )
  const states: string[][] = []
  const draws = { atInstall: read().length > 0, states }
  window.__catalogDraws = draws
  const record = (): void => {
    const next = read()
    const last = draws.states.at(-1)
    if (next.length > 0 && next.join('|') !== last?.join('|')) {
      draws.states.push(next)
    }
  }
  new MutationObserver(record).observe(document, {
    subtree: true,
    childList: true,
    attributes: true
  })
}

type Timed = { ackMs: number; visibleMs: number }

/** What the sidebar shows once main has published a step: header entries and text. */
type Shown = {
  has?: string[]
  hasPrefix?: string[]
  lacksPrefix?: string[]
  /** The first prefix's header sits above the second's. */
  above?: [string, string]
  text?: string
}

type Step =
  | { kind: 'reorder'; orderedIds: string[] }
  | { kind: 'move'; repoId: string; groupId: string | null }
  | { kind: 'renameGroup'; groupId: string; name: string }
  | { kind: 'deleteGroup'; groupId: string }
  | { kind: 'renameProject'; repoId: string; name: string }
  | { kind: 'removeProject'; repoId: string }

/** Runs `step` in the window; times main's answer and the first committed sidebar showing `shown`. */
async function timeStep(page: Page, step: Step, shown: Shown): Promise<Timed> {
  return page.evaluate(
    async ({ step, shown }) => {
      const state = (): ReturnType<NonNullable<typeof window.__store>['getState']> =>
        window.__store!.getState()
      const sidebar = document.querySelector('[data-worktree-sidebar]')
      const matches = (): boolean => {
        const list = window.__catalogHeaders?.() ?? []
        const at = (prefix: string): number => list.findIndex((entry) => entry.startsWith(prefix))
        return (
          (shown.has ?? []).every((entry) => list.includes(entry)) &&
          (shown.hasPrefix ?? []).every((prefix) => at(prefix) >= 0) &&
          (shown.lacksPrefix ?? []).every((prefix) => at(prefix) === -1) &&
          (!shown.above || (at(shown.above[0]) >= 0 && at(shown.above[0]) < at(shown.above[1]))) &&
          (!shown.text || (sidebar?.textContent ?? '').includes(shown.text))
        )
      }
      const repo = (id: string) => {
        const found = window.__projectCatalog!().repos.find((candidate) => candidate.id === id)
        if (!found) {
          throw new Error(`missing repo ${id}`)
        }
        return found
      }
      const startedAt = performance.now()
      const visible = new Promise<number>((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (matches()) {
            observer.disconnect()
            resolve(performance.now())
          }
        })
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        })
        setTimeout(() => {
          observer.disconnect()
          reject(new Error(`sidebar never showed ${JSON.stringify(shown)}`))
        }, 15_000)
      })
      const run = async (): Promise<unknown> => {
        switch (step.kind) {
          case 'reorder':
            return state().reorderRepos(step.orderedIds)
          case 'move':
            return state().moveProjectToGroup(repo(step.repoId), step.groupId)
          case 'renameGroup':
            return state().updateProjectGroup(
              step.groupId,
              { name: step.name },
              { hostId: 'local' }
            )
          case 'deleteGroup':
            return state().deleteProjectGroup(step.groupId, { hostId: 'local' })
          case 'renameProject':
            return state().updateRepo(step.repoId, { displayName: step.name }, { hostId: 'local' })
          case 'removeProject':
            return state().removeProject(step.repoId, { hostId: 'local', errorFeedback: 'silent' })
        }
      }
      const ackAt = await run().then(() => performance.now())
      const visibleAt = await visible
      return { ackMs: ackAt - startedAt, visibleMs: visibleAt - startedAt }
    },
    { step, shown }
  )
}

/** A committed git repo in its own temp dir, removed with it. */
async function createRepo(): Promise<string> {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-catalog-')))
  for (const args of [
    ['init'],
    [
      '-c',
      'user.name=E2E',
      '-c',
      'user.email=e2e@test.local',
      'commit',
      '--allow-empty',
      '-m',
      'seed'
    ]
  ]) {
    const result = await runProcess({ program: 'git', args, cwd: dir, timeoutMs: 10_000 })
    expect(result.code, result.stderr).toBe(0)
  }
  return dir
}

test('project and group create, rename, reorder, move and delete show from main', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const repoPaths = [await createRepo(), await createRepo()]
  registerPostElectronShutdownCleanup(async () => {
    for (const repoPath of repoPaths) {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
  const [a, b] = await addRepos(orcaPage, repoPaths)
  await orcaPage.evaluate(installHeaderReader)
  const headers = (): Promise<string[]> =>
    orcaPage.evaluate(() => window.__catalogHeaders?.() ?? [])
  await expect
    .poll(headers)
    .toEqual(expect.arrayContaining([`project:${a}@ungrouped`, `project:${b}@ungrouped`]))
  const timings: Record<string, Timed> = {}

  const drawn = await headers()
  const position = (id: string): number => drawn.indexOf(`project:${id}@ungrouped`)
  const [upper, lower] = position(a) < position(b) ? [a, b] : [b, a]
  const allIds = await orcaPage.evaluate(() => window.__projectCatalog!().repos.map((r) => r.id))
  timings.reorder = await timeStep(
    orcaPage,
    {
      kind: 'reorder',
      orderedIds: [...allIds.filter((id) => id !== upper && id !== lower), lower, upper]
    },
    { above: [`project:${lower}@`, `project:${upper}@`] }
  )

  // Create shows nothing alone: an empty group lists no header. Create then move is the menu's flow.
  const createdAt = Date.now()
  const group = await orcaPage.evaluate(() =>
    window.__store!.getState().createProjectGroup('Alpha', 'local')
  )
  if (!group) {
    throw new Error('group create failed')
  }
  const createAckMs = Date.now() - createdAt
  const moveIn = await timeStep(
    orcaPage,
    { kind: 'move', repoId: a, groupId: group.id },
    { has: [`project:${a}@group:${group.id}`], hasPrefix: [`group:${group.id}:Alpha`] }
  )
  timings.createGroup = { ackMs: createAckMs, visibleMs: createAckMs + moveIn.visibleMs }
  timings.moveIntoGroup = moveIn
  timings.moveSecondIntoGroup = await timeStep(
    orcaPage,
    { kind: 'move', repoId: b, groupId: group.id },
    { has: [`project:${b}@group:${group.id}`] }
  )
  timings.renameGroup = await timeStep(
    orcaPage,
    { kind: 'renameGroup', groupId: group.id, name: 'Beta' },
    { has: [`group:${group.id}:Beta`] }
  )
  timings.moveOutOfGroup = await timeStep(
    orcaPage,
    { kind: 'move', repoId: a, groupId: null },
    { has: [`project:${a}@ungrouped`] }
  )
  timings.deleteGroup = await timeStep(
    orcaPage,
    { kind: 'deleteGroup', groupId: group.id },
    { lacksPrefix: [`group:${group.id}:`], has: [`project:${b}@ungrouped`] }
  )
  timings.renameProject = await timeStep(
    orcaPage,
    { kind: 'renameProject', repoId: a, name: 'renamed-project' },
    { text: 'renamed-project' }
  )
  timings.deleteProject = await timeStep(
    orcaPage,
    { kind: 'removeProject', repoId: a },
    { lacksPrefix: [`project:${a}@`] }
  )

  // The window keeps no catalog copy: its store fields stay empty through every write.
  const windowCopy = await orcaPage.evaluate(() => {
    const { repos, projectGroups, projects, projectHostSetups } = window.__store!.getState()
    return repos.length + projectGroups.length + projects.length + projectHostSetups.length
  })
  expect(windowCopy).toBe(0)
  console.log(`[catalog-timing] ${JSON.stringify(timings)}`)
  await testInfo.attach('catalog-timings.json', {
    body: JSON.stringify(timings, null, 2),
    contentType: 'application/json'
  })
})

async function addRepos(page: Page, repoPaths: string[]): Promise<string[]> {
  const ids = await page.evaluate(async (paths) => {
    const store = window.__store!
    const added: string[] = []
    for (const repoPath of paths) {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      added.push(result.repo.id)
    }
    await store.getState().awaitLocalRepoCatalogSettlement()
    store.getState().setGroupBy('repo')
    store.getState().setProjectOrderBy('manual')
    await window.api.ui.set({ groupBy: 'repo', projectOrderBy: 'manual' })
    return added
  }, repoPaths)
  if (ids.length !== repoPaths.length) {
    throw new Error('the repos were not added')
  }
  return ids
}

async function installDrawRecorder(app: ElectronApplication): Promise<void> {
  const source = `(${recordHeaderDraws.toString()})()`
  await app.evaluate(({ app, webContents }, script) => {
    const install = (contents: WebContents): void => {
      if (contents.getType() !== 'window') {
        return
      }
      const run = (): void => {
        void contents.executeJavaScript(script)
      }
      if (contents.isLoading() || !contents.getURL()) {
        contents.once('dom-ready', run)
      } else {
        run()
      }
    }
    webContents.getAllWebContents().forEach(install)
    app.once('web-contents-created', (_event, contents) => install(contents))
  }, source)
}

test('a restored project catalog draws its headers once', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(3 * 60_000)
  const session = createRestartSession(testInfo)
  const repoPaths = [await createRepo(), await createRepo()]
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const [grouped, loose] = await addRepos(first.page, repoPaths)
    const groupId = await first.page.evaluate(async (repoId) => {
      const store = window.__store!
      const group = await store.getState().createProjectGroup('Restored', 'local')
      const repo = window.__projectCatalog!().repos.find((candidate) => candidate.id === repoId)
      if (!group || !repo || !(await store.getState().moveProjectToGroup(repo, group.id))) {
        throw new Error('group setup failed')
      }
      return group.id
    }, grouped)
    const expected = {
      groupId,
      grouped: `${grouped}@group:${groupId}`,
      loose: `${loose}@ungrouped`
    }
    await session.close(first.app)
    app = null

    const second = await session.launch({ beforeFirstWindow: installDrawRecorder })
    app = second.app
    await waitForSessionReady(second.page)
    const draws = (): Promise<{ atInstall: boolean; states: string[][] } | null> =>
      second.page.evaluate(() => window.__catalogDraws ?? null)
    await expect
      .poll(async () => (await draws())?.states.at(-1) ?? [])
      .toEqual(expect.arrayContaining([expected.groupId, expected.grouped, expected.loose]))
    // Give a late regroup time to land before reading every state drawn.
    await second.page.waitForTimeout(2_000)
    const recorded = await draws()
    await testInfo.attach('header-draws.json', {
      body: JSON.stringify(recorded, null, 2),
      contentType: 'application/json'
    })
    expect(recorded?.atInstall).toBe(false)
    const firstWithCatalog = recorded?.states.findIndex((state) => state.includes(expected.groupId))
    expect(firstWithCatalog).toBe(0)
    expect(recorded?.states.at(0)).toEqual(recorded?.states.at(-1))
  } finally {
    await session.dispose(app ?? undefined)
    for (const repoPath of repoPaths) {
      rmSync(repoPath, { recursive: true, force: true })
    }
  }
})
