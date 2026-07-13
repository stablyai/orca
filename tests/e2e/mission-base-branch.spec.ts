import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'

function initRepo(prefix: string): string {
  const repoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  execSync('git init', { cwd: repoDir, stdio: 'pipe' })
  execSync('git config user.email "e2e@test.local"', { cwd: repoDir, stdio: 'pipe' })
  execSync('git config user.name "E2E Test"', { cwd: repoDir, stdio: 'pipe' })
  writeFileSync(path.join(repoDir, 'README.md'), `# ${prefix}\n`)
  execSync('git add -A && git commit -m "init"', { cwd: repoDir, stdio: 'pipe' })
  return repoDir
}

test.describe('Mission base branch', () => {
  test('resolves the base ref per member repo and fails only members lacking it', async ({
    orcaPage
  }) => {
    // Repo A has a develop branch whose tip carries a marker file that the
    // default branch does not have; repo B has no develop branch at all.
    const repoA = initRepo('orca-e2e-base-a-')
    execSync('git checkout -b develop', { cwd: repoA, stdio: 'pipe' })
    writeFileSync(path.join(repoA, 'develop-marker.txt'), 'only on develop\n')
    execSync('git add -A && git commit -m "develop marker"', { cwd: repoA, stdio: 'pipe' })
    execSync('git checkout -', { cwd: repoA, stdio: 'pipe' })
    const repoB = initRepo('orca-e2e-base-b-')
    const repoAName = path.basename(repoA)
    const repoBName = path.basename(repoB)

    try {
      for (const repoPath of [repoA, repoB]) {
        await orcaPage.evaluate(async (target) => {
          await window.api.repos.add({ path: target })
        }, repoPath)
      }
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async (paths) => {
                const store = window.__store
                if (!store) {
                  return false
                }
                await store.getState().fetchRepos()
                const repos = store.getState().repos
                return paths.every((target) => repos.some((repo) => repo.path === target))
              },
              [repoA, repoB]
            ),
          { timeout: 30_000 }
        )
        .toBe(true)

      await orcaPage.getByRole('button', { name: 'Missions', exact: true }).click()
      await orcaPage.getByRole('button', { name: 'New Mission' }).first().click()
      await orcaPage.getByLabel('Mission Name').fill('Base Check')

      // Pick exactly the two scenario repos (the fixture's seeded repo must
      // stay out so the expected outcome is one success + one failure).
      await orcaPage.locator('[role="combobox"]:not([data-agent-combobox-root])').click()
      for (const repoName of [repoAName, repoBName]) {
        await orcaPage.getByPlaceholder('Search projects...').fill(repoName)
        await orcaPage.getByText(repoName, { exact: true }).click()
      }
      await orcaPage.keyboard.press('Escape')

      await orcaPage.getByRole('button', { name: 'Advanced' }).click()
      await orcaPage.getByLabel('Base branch').fill('develop')
      await orcaPage.getByRole('button', { name: 'Create Mission' }).click({ timeout: 10_000 })

      // Partial failure: the dialog stays open reporting the member that
      // lacks the requested base ref.
      await expect(
        orcaPage.getByText(
          'Some workspaces could not be created. You can retry from the mission list.'
        )
      ).toBeVisible({ timeout: 60_000 })
      await orcaPage.getByRole('button', { name: 'Done' }).click()

      // Repo A's member worktree was created FROM develop: its checkout
      // physically contains the develop-only marker file.
      const members = await orcaPage.evaluate(
        ([pathA, pathB]) => {
          const state = window.__store!.getState()
          const mission = state.missions.find((candidate) => candidate.name === 'Base Check')
          const repoIdByPath = new Map(state.repos.map((repo) => [repo.path, repo.id]))
          const byRepoId = new Map(
            (mission?.members ?? []).map((member) => [member.repoId, member.worktreeId])
          )
          return {
            memberA: byRepoId.get(repoIdByPath.get(pathA) ?? '') ?? null,
            memberB: byRepoId.get(repoIdByPath.get(pathB) ?? '') ?? null
          }
        },
        [repoA, repoB]
      )
      expect(members.memberA).toBeTruthy()
      expect(members.memberB).toBeNull()
      const memberAPath = members.memberA!.slice(members.memberA!.indexOf('::') + 2)
      expect(existsSync(path.join(memberAPath, 'develop-marker.txt'))).toBe(true)

      // The failed member degrades to a recreate row naming the missing ref;
      // the successful sibling keeps its worktree card on the mission branch.
      await expect(orcaPage.getByText('mission/base-check').first()).toBeVisible({
        timeout: 30_000
      })
      await expect(orcaPage.getByText(/base branch develop/)).toBeVisible()
      await expect(orcaPage.getByRole('button', { name: 'Recreate' })).toBeVisible()

      // Cleanup inside the app so the mission worktree is released before rm.
      await orcaPage.evaluate(async () => {
        const state = window.__store!.getState()
        const mission = state.missions.find((candidate) => candidate.name === 'Base Check')
        if (mission) {
          await state.deleteMission(mission.id, true)
        }
      })
    } finally {
      rmSync(repoA, { recursive: true, force: true })
      rmSync(repoB, { recursive: true, force: true })
    }
  })
})
