/**
 * The WSL move fence on a real desktop: a journal written beside the profile, as a move would,
 * must make the moving projects (a folder and a repo) refuse new terminals while they stay listed,
 * and once the host owns them, take them out of the project and worktree lists. Other projects
 * keep working throughout.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { wslMoveCutoverFixture } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { writeWslMoveCutover } from '../../src/main/persistence/moving-wsl-projects/wsl-move-cutover-journal'
import {
  WSL_MOVE_CUTOVER_PHASES,
  type WslMoveCutoverPhase
} from '../../src/shared/wsl-move/wsl-move-cutover'

test.use({ seedTestRepo: false })

async function createFolders(page: Page, folders: { name: string; folderPath: string }[]) {
  return page.evaluate(async (entries) => {
    const state = window.__store!.getState()
    const ids: string[] = []
    for (const entry of entries) {
      const group = await window.api.projectGroups.create({
        name: entry.name,
        parentPath: entry.folderPath,
        createdFrom: 'folder-scan'
      })
      await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
      const workspace = group
        ? await state.createFolderWorkspace(
            { projectGroupId: group.id, ...entry },
            { runtimeEnvironmentId: null }
          )
        : null
      if (!workspace) {
        throw new Error(`Could not create folder workspace ${entry.name}`)
      }
      ids.push(workspace.id)
    }
    return ids
  }, folders)
}

async function addRepo(page: Page, repoPath: string): Promise<string> {
  return page.evaluate(async (path) => {
    const result = await window.api.repos.add({ path })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, repoPath)
}

/** The spawn's outcome as the renderer sees it: a pty id, or the refusal message. */
async function spawnIn(page: Page, worktreeId: string, cwd: string): Promise<string> {
  return page.evaluate(
    async ({ id, cwd }) => {
      try {
        const result = await window.api.pty.spawn({
          cols: 80,
          rows: 24,
          cwd,
          worktreeId: id,
          initiallyHidden: true
        })
        await window.api.pty.kill(result.id)
        return 'spawned'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    { id: worktreeId, cwd }
  )
}

/** An edit's outcome as the renderer sees it: 'saved', 'ignored' (dropped quietly) or the refusal. */
async function edit(
  page: Page,
  target: { worktreeId: string } | { folderWorkspaceId: string },
  updates: Record<string, unknown>
): Promise<string> {
  return page.evaluate(
    async ({ target, updates }) => {
      try {
        const result =
          'worktreeId' in target
            ? await window.api.worktrees.updateMeta({ worktreeId: target.worktreeId, updates })
            : await window.api.folderWorkspaces.update({
                folderWorkspaceId: target.folderWorkspaceId,
                updates
              })
        return result ? 'saved' : 'ignored'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    { target, updates }
  )
}

async function listed(page: Page) {
  return page.evaluate(async () => {
    // Why repos first: the repo catalog is the moved-project fence; worktrees are listed per catalog repo.
    const repos = (await window.api.repos.list()).map((repo) => repo.id)
    const listings = await Promise.all(
      repos.map((repoId) => window.api.worktrees.listDetected({ repoId }))
    )
    return {
      folders: (await window.api.folderWorkspaces.list()).map((workspace) => workspace.id),
      repos,
      worktrees: listings.flatMap((result) =>
        result.worktrees.filter((worktree) => worktree.visible).map((worktree) => worktree.repoId)
      )
    }
  })
}

test('a WSL move journal fences the moving project, then hides it once the host owns it', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-wsl-move-fence-'))
  const folders = ['Moving notes', 'Staying notes'].map((name) => {
    const folderPath = join(root, name)
    mkdirSync(folderPath)
    return { name, folderPath }
  })
  const repoPath = join(root, 'moving-repo')
  mkdirSync(repoPath)
  const gitIdentity = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid']
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', [...gitIdentity, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: repoPath
  })
  const session = createRestartSession(testInfo)
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const [movingId, stayingId] = await createFolders(launched.page, folders)
    const repoId = await addRepo(launched.page, repoPath)
    const repoWorktreeId = `${repoId}::${repoPath}`
    await session.close(launched.app)
    launched = undefined

    const record = (phase: WslMoveCutoverPhase) =>
      wslMoveCutoverFixture(
        'move-1',
        phase,
        {},
        { repoIds: [repoId], folderWorkspaceIds: [movingId] }
      )
    const expectMovingRefused = async (page: Page) => {
      expect(await spawnIn(page, `folder:${movingId}`, folders[0].folderPath)).toContain(
        'moving to its WSL host'
      )
      expect(await spawnIn(page, repoWorktreeId, repoPath)).toContain('moving to its WSL host')
      expect(await spawnIn(page, `folder:${stayingId}`, folders[1].folderPath)).toBe('spawned')
      // A user's edit is refused; background bookkeeping is dropped quietly, never an error.
      expect(
        await edit(page, { worktreeId: repoWorktreeId }, { displayName: 'Renamed' })
      ).toContain('moving to its WSL host')
      expect(
        await edit(page, { folderWorkspaceId: movingId }, { name: 'Renamed notes' })
      ).toContain('moving to its WSL host')
      expect(
        await edit(page, { worktreeId: repoWorktreeId }, { isUnread: true, lastActivityAt: 1 })
      ).toBe('ignored')
      expect(await edit(page, { folderWorkspaceId: stayingId }, { name: 'Still mine' })).toBe(
        'saved'
      )
    }

    // The journal only moves forward one phase at a time, as a real move writes it.
    let journaled = -1
    const advanceTo = (phase: WslMoveCutoverPhase) => {
      const target = WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
      for (journaled += 1; journaled <= target; journaled += 1) {
        writeWslMoveCutover(session.userDataDir, record(WSL_MOVE_CUTOVER_PHASES[journaled]))
      }
      journaled = target
    }

    advanceTo('source-fenced')
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    await expectMovingRefused(launched.page)
    const whileMoving = await listed(launched.page)
    expect(whileMoving.folders).toEqual(expect.arrayContaining([movingId, stayingId]))
    expect(whileMoving.repos).toContain(repoId)
    expect(whileMoving.worktrees).toContain(repoId)
    await session.close(launched.app)
    launched = undefined

    advanceTo('destination-committed')
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    await expectMovingRefused(launched.page)
    const owned = await listed(launched.page)
    expect(owned.folders).toContain(stayingId)
    expect(owned.folders).not.toContain(movingId)
    expect(owned.repos).not.toContain(repoId)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
