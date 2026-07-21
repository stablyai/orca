/**
 * E2E: linked work item behavior when switching the composer project.
 *
 * Why: Jira/Linear issues are workspace-scoped context — switching the
 * implementation project must keep them attached. They used to be dropped,
 * leaving only the derived name in the smart field. GitHub/GitLab sources
 * are repo-scoped and must still clear on a project switch.
 *
 * Why E2E: the preservation logic lives in useComposerState behind the real
 * ProjectCombobox interaction and main-process repo resolution — a store
 * slice unit test cannot reach the combobox → handleProjectChange → smart
 * field pill re-render path.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { LinkedWorkItemSummary } from '../../src/renderer/src/lib/new-workspace'

const SECOND_PROJECT_NAME = 'linked-item-second-project'

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

function createGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])
  writeFileSync(path.join(repoPath, 'README.md'), '# Linked item project switch E2E\n')
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'Initial commit'])
}

async function addSecondProject(page: Page, repoPath: string): Promise<void> {
  await page.evaluate(async (targetRepoPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const addedRepo = await store.getState().addRepoPath(targetRepoPath)
    if (!addedRepo) {
      throw new Error(`Failed to add repo at ${targetRepoPath}`)
    }
  }, repoPath)
}

async function openComposerWithLinkedWorkItem(
  page: Page,
  linkedWorkItem: LinkedWorkItemSummary,
  prefilledName: string
): Promise<void> {
  await page.evaluate(
    ({ linkedWorkItem, prefilledName }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openModal('new-workspace-composer', { linkedWorkItem, prefilledName })
    },
    { linkedWorkItem, prefilledName }
  )
}

async function switchComposerProject(page: Page, projectName: string): Promise<void> {
  const composer = page.getByRole('dialog')
  const combobox = composer.locator('button[data-project-combobox-root="true"]')
  await combobox.click()
  await page.getByRole('option', { name: new RegExp(projectName) }).click()
  await expect(combobox).toContainText(projectName)
}

test.describe('New workspace composer linked item across project switches', () => {
  let tempRoot: string
  let secondRepoPath: string

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-linked-item-'))
    secondRepoPath = path.join(tempRoot, SECOND_PROJECT_NAME)
    createGitRepo(secondRepoPath)
    await addSecondProject(orcaPage, secondRepoPath)
  })

  test.afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('keeps a Jira issue linked when the project changes', async ({ orcaPage }) => {
    await openComposerWithLinkedWorkItem(
      orcaPage,
      {
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: 'RDG-344 Migrate homepage from NuxtJS to NextJS',
        url: 'https://example.atlassian.net/browse/RDG-344',
        jiraIdentifier: 'RDG-344'
      },
      'rdg-344-nuxtjs-nextjs'
    )

    const composer = orcaPage.getByRole('dialog')
    await expect(composer).toBeVisible()
    const sourcePill = composer.locator('[data-workspace-source-pill="true"]')
    await expect(sourcePill).toContainText('RDG-344 Migrate homepage from NuxtJS to NextJS')

    await switchComposerProject(orcaPage, SECOND_PROJECT_NAME)

    await expect(sourcePill).toContainText('RDG-344 Migrate homepage from NuxtJS to NextJS')
  })

  test('clears a repo-scoped GitHub issue when the project changes', async ({ orcaPage }) => {
    await openComposerWithLinkedWorkItem(
      orcaPage,
      {
        type: 'issue',
        provider: 'github',
        number: 41,
        title: 'Fix crash on launch',
        url: 'https://github.com/acme/app/issues/41'
      },
      'fix-crash-on-launch'
    )

    const composer = orcaPage.getByRole('dialog')
    await expect(composer).toBeVisible()
    const sourcePill = composer.locator('[data-workspace-source-pill="true"]')
    await expect(sourcePill).toContainText('#41 Fix crash on launch')

    await switchComposerProject(orcaPage, SECOND_PROJECT_NAME)

    await expect(sourcePill).toHaveCount(0)
  })
})
