import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'

const PR_NUMBER = 77
const PR_TITLE = 'Add retry to the upload client'
const PR_URL = `https://github.com/acme/repo/pull/${PR_NUMBER}`
const REVIEW_TEMPLATE = '/code-review {prUrl} xhigh --comment with codex.'
// Why: the fake agent echoes what it receives, so the prompt shows once and Enter shows as SUBMIT.
const RENDERED_PROMPT = `/code-review ${PR_URL} xhigh --comment with codex.`
const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-pr-custom-actions-'))
const unhandledGhLog = path.join(fakeCliDir, 'unhandled-gh.log')

const fakeGhSource = `
const args = process.argv.slice(2)
const joined = args.join(' ')
if (args[0] === 'auth' && args[1] === 'status') {
  console.error('github.com\\n  ✓ Logged in to github.com account e2e (GITHUB_TOKEN)')
  process.exit(0)
}
if (args[0] === 'api' && args[1] === 'user') {
  console.log(JSON.stringify({ login: 'e2e' }))
  process.exit(0)
}
if (args[0] === 'api' && args.includes('rate_limit')) {
  console.log(JSON.stringify({ resources: { core: { limit: 5000, remaining: 5000, reset: 0 }, graphql: { limit: 5000, remaining: 5000, reset: 0 }, search: { limit: 30, remaining: 30, reset: 0 } } }))
  process.exit(0)
}
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list') {
  console.log('[]')
  process.exit(0)
}
require('node:fs').appendFileSync(${JSON.stringify(unhandledGhLog)}, joined + '\\n')
console.error('fake gh: unhandled ' + joined)
process.exit(1)
`

// Why: enabling bracketed paste and going quiet is the composer-ready signal Orca waits for
// before it pastes and submits; echoing stdin shows what the agent received.
const fakeClaudeSource = `
process.stdout.write('E2E_CLAUDE_READY\\n\\x1b[?2004h')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  const raw = chunk.toString()
  const text = raw.replace(/\\x1b\\[20[01]~/g, '').replace(/\\r/g, '')
  if (text) process.stdout.write('\\nE2E_CLAUDE_INPUT\\n' + text + '\\n')
  if (raw.includes('\\r')) process.stdout.write('\\nE2E_CLAUDE_SUBMIT\\n')
})
setInterval(() => {}, 60_000)
`

function installFakeCli(name: 'gh' | 'claude', source: string): void {
  if (process.platform === 'win32') {
    writeFileSync(path.join(fakeCliDir, `fake-${name}.js`), source)
    writeFileSync(
      path.join(fakeCliDir, `${name}.cmd`),
      `@echo off\r\nnode "%~dp0\\fake-${name}.js" %*\r\n`
    )
    return
  }
  const executable = path.join(fakeCliDir, name)
  writeFileSync(executable, `#!/usr/bin/env node\n${source}`)
  chmodSync(executable, 0o755)
}

installFakeCli('gh', fakeGhSource)
installFakeCli('claude', fakeClaudeSource)
appendFileSync(unhandledGhLog, '')

const test = base.extend({
  launchEnv: [
    {
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`
    },
    { option: true }
  ]
})

// Why: testRepoPath is shared by every spec in this worker, so the GitHub remote must not outlive this file.
test.afterAll(({ testRepoPath }) => {
  try {
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: testRepoPath, stdio: 'ignore' })
  } catch {
    // Already removed.
  }
  rmSync(fakeCliDir, { recursive: true, force: true })
})

// Why: `repos.add` probes the remote once at launch, so origin must exist before Electron starts.
test.beforeAll(({ testRepoPath }) => {
  try {
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: testRepoPath, stdio: 'ignore' })
  } catch {
    // The disposable E2E repo does not have an origin on its first run.
  }
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/repo.git'], {
    cwd: testRepoPath,
    stdio: 'pipe'
  })
})

// Why: the PR body depends on details this fixture does not serve; the evidence is the split button's menu.
async function workspaceMenuClip(
  page: Page
): Promise<{ x: number; y: number; width: number; height: number }> {
  const button = await page
    .getByRole('button', { name: 'Resume workspace attached to PR' })
    .boundingBox()
  const menu = await page.getByRole('menu').boundingBox()
  if (!button || !menu) {
    throw new Error('PR workspace button or menu is not laid out')
  }
  const padding = 16
  const x = Math.max(0, Math.min(button.x, menu.x) - padding)
  const y = Math.max(0, button.y - padding)
  return {
    x,
    y,
    width: Math.max(button.x + button.width, menu.x + menu.width) + padding - x,
    height: menu.y + menu.height + padding - y
  }
}

test('a pull request custom action resumes the attached workspace and sends its prompt', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  await orcaPage.evaluate(
    async ({ prNumber, prTitle, prUrl, template }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const workspace = state
        .allWorktrees()
        .find((worktree) => worktree.branch?.endsWith('e2e-secondary'))
      if (!workspace) {
        throw new Error('Seeded secondary E2E worktree is not available')
      }
      const attached = await state.updateWorktreeMeta(workspace.id, { linkedPR: prNumber })
      if (!attached.ok) {
        throw new Error(attached.error)
      }
      const settings = store.getState().settings
      await state.updateSettings({
        uiLanguage: 'en',
        defaultTuiAgent: 'claude',
        disabledTuiAgents: [],
        ...(navigator.userAgent.includes('Windows') ? { terminalWindowsShell: 'git-bash' } : {}),
        sourceControlAi: {
          ...settings!.sourceControlAi!,
          customActions: [{ id: 'review', label: 'Review', commandInputTemplate: template }]
        }
      })
      store.getState().openTaskPage({
        taskSource: 'github',
        openGitHubWorkItem: {
          id: `pr-${prNumber}`,
          type: 'pr',
          number: prNumber,
          title: prTitle,
          state: 'open',
          url: prUrl,
          labels: [],
          updatedAt: '2026-10-20T12:00:00.000Z',
          author: 'e2e',
          branchName: 'e2e-secondary',
          baseRefName: 'main',
          repoId: workspace.repoId
        }
      })
    },
    { prNumber: PR_NUMBER, prTitle: PR_TITLE, prUrl: PR_URL, template: REVIEW_TEMPLATE }
  )

  await expect(orcaPage.getByRole('heading', { name: PR_TITLE })).toBeVisible({ timeout: 15_000 })
  await expect(
    orcaPage.getByRole('button', { name: 'Resume workspace attached to PR' })
  ).toBeVisible()

  await orcaPage.getByRole('button', { name: 'More PR workspace actions' }).click()
  const menu = orcaPage.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Review',
    'Start new workspace',
    'Open on GitHub',
    'Manage custom actions…'
  ])
  await menu.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  )
  await orcaPage.screenshot({
    path: testInfo.outputPath('pr-custom-actions-menu.png'),
    clip: await workspaceMenuClip(orcaPage)
  })

  await menu.getByRole('menuitem', { name: 'Review' }).click()

  let terminalText = ''
  await expect
    .poll(
      async () => {
        terminalText = await getTerminalContent(orcaPage, 12_000)
        return terminalText
      },
      { timeout: 30_000, message: 'The custom action prompt did not reach the agent' }
    )
    .toContain('E2E_CLAUDE_SUBMIT')
  expect(terminalText.split(RENDERED_PROMPT)).toHaveLength(2)
  expect(readFileSync(unhandledGhLog, 'utf8')).toBe('')
})
