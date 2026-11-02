import { expect, type Page } from '@stablyai/playwright-test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import { attachRepoAndOpenTerminal } from './helpers/orca-restart'
import { configureRendererScaleFixture } from '../../config/scripts/idle-cpu-renderer-scale-fixture.mjs'

export async function createSpinnerRepository(worktrees: number) {
  const parent = path.resolve('.bench-fixtures')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(path.join(parent, 'spinner-workspaces-'))
  const repoPath = path.join(directory, 'primary')
  mkdirSync(repoPath)
  const git = async (args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd: repoPath })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
  }
  await git(['init'])
  await git(['config', 'user.email', 'spinner-benchmark@test.local'])
  await git(['config', 'user.name', 'Spinner benchmark'])
  await git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(repoPath, 'README.md'), '# Spinner benchmark\n')
  await git(['add', 'README.md'])
  await git(['commit', '-m', 'Spinner fixture'])
  for (let index = 1; index < worktrees; index++) {
    await git([
      'worktree',
      'add',
      '-b',
      `spinner-${index}`,
      path.join(directory, `workspace-${index}`)
    ])
  }
  return { directory, repoPath }
}

export async function seedSpinnerWorkspaces(
  page: Page,
  repoPath: string,
  options: {
    worktrees: number
    lineageDepth: number
    agentsPerWorktree: number
    subagentsPerAgent: number
  }
) {
  await attachRepoAndOpenTerminal(page, repoPath)
  await page.evaluate(async () => {
    const store = window.__store!
    const repo = store.getState().repos[0]
    await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
    const paths = (store.getState().detectedWorktreesByRepo[repo.id]?.worktrees ?? [])
      .filter((worktree) => !worktree.selectedCheckout)
      .map((worktree) => worktree.path)
    await store.getState().updateRepo(repo.id, {
      externalWorktreeVisibility: 'show',
      importedExternalWorktreePaths: paths,
      externalWorktreeInboxBaselinePaths: paths
    })
    await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
  })
  await page.waitForFunction(
    (count) => Object.values(window.__store!.getState().worktreesByRepo).flat().length === count,
    options.worktrees
  )
  const seeded = await configureRendererScaleFixture(page, options, repoPath)
  const expandedChildAgentLists = options.subagentsPerAgent
    ? await expandMountedChildAgentLists(page)
    : 0
  return { ...seeded, expandedChildAgentLists }
}

// Child agent lists start collapsed (#36936); open mounted ones so subagent spinners render.
async function expandMountedChildAgentLists(page: Page) {
  const collapsed =
    '[data-worktree-sidebar] [data-agent-child-disclosure-button][aria-expanded="false"]'
  await page.waitForSelector(collapsed, { state: 'attached' })
  let expanded = 0
  // Expanding grows cards and can mount more virtualized cards, so click until none remain.
  await expect
    .poll(
      async () => {
        const clicked = await page.evaluate((selector) => {
          const buttons = [...document.querySelectorAll<HTMLElement>(selector)]
          for (const button of buttons) {
            button.click()
          }
          return buttons.length
        }, collapsed)
        expanded += clicked
        return clicked
      },
      { intervals: [250] }
    )
    .toBe(0)
  return expanded
}

export async function refreshSpinnerAgents(page: Page) {
  return page.evaluate(() => {
    const store = window.__store!
    const agents = Object.values(store.getState().agentStatusByPaneKey).filter((entry) =>
      entry.prompt?.startsWith('Idle CPU agent ')
    )
    for (const entry of agents) {
      store.getState().setAgentStatus(
        entry.paneKey,
        {
          state: 'working',
          prompt: entry.prompt,
          agentType: entry.agentType,
          subagents: entry.subagents
        },
        entry.agentType,
        { updatedAt: Date.now(), stateStartedAt: entry.stateStartedAt },
        {
          tabId: entry.tabId,
          worktreeId: entry.worktreeId
        }
      )
    }
    return agents.length
  })
}

export async function startSpinnerStatusTraffic(page: Page) {
  return page.evaluateHandle(() => {
    const store = window.__store!
    const keys = Object.values(store.getState().agentStatusByPaneKey)
      .filter((entry) => entry.prompt?.startsWith('Idle CPU agent '))
      .map((entry) => entry.paneKey)
    let cursor = 0
    let updates = 0
    const timer = setInterval(() => {
      for (let index = 0; index < Math.min(8, keys.length); index++) {
        const entry = store.getState().agentStatusByPaneKey[keys[cursor++ % keys.length]]
        store.getState().setAgentStatus(
          entry.paneKey,
          {
            state: 'working',
            prompt: entry.prompt,
            agentType: entry.agentType,
            subagents: entry.subagents
          },
          entry.agentType,
          { updatedAt: Date.now(), stateStartedAt: entry.stateStartedAt },
          {
            tabId: entry.tabId,
            worktreeId: entry.worktreeId
          }
        )
        updates++
      }
    }, 200)
    return {
      stop() {
        clearInterval(timer)
        return updates
      }
    }
  })
}
