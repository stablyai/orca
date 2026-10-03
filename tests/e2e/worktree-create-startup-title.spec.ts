import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { stageNodeScriptForTerminal } from './helpers/run-node-script-in-terminal'
import { readPersistedProfileState } from './helpers/persisted-profile-state'
import { parseWorkspaceSession } from '../../src/shared/workspace-session-schema'
import { runProcess } from '../../src/shared/child-process/run-process'

test('worktree create names the agent tab before launch and keeps it through OSC updates', async ({
  orcaPage: page,
  electronApp
}) => {
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const changeMarker = path.join(profile, 'change-title')
  const fixture = stageNodeScriptForTerminal(
    [
      'const fs = require("node:fs");',
      'process.stdout.write("\\x1b]0;Claude Code\\x07Startup title fixture: no model calls\\r\\n");',
      'let changed = false;',
      `setInterval(() => { if (!changed && fs.existsSync(${JSON.stringify(changeMarker)})) { changed = true; process.stdout.write("\\x1b]0;✳ Claude Code\\x07Agent OSC title updated\\r\\n"); } }, 100);`
    ].join(''),
    { dir: profile, prefix: 'startup-title-agent' }
  )
  await page.evaluate(async (command) => {
    await window.api.settings.set({
      agentCmdOverrides: { claude: command },
      agentDefaultArgs: { claude: '' }
    })
  }, fixture.command)
  const repoId = await page.evaluate(() => window.__store!.getState().repos[0].id)
  const result = await runProcess({
    program: process.execPath,
    args: [
      path.resolve('out/cli/index.js'),
      'worktree',
      'create',
      '--repo',
      `id:${repoId}`,
      '--name',
      'agent-task',
      '--agent',
      'claude',
      '--title',
      'Review tests',
      '--setup',
      'skip',
      '--no-parent',
      '--json'
    ],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_USER_DATA_PATH: profile,
      ORCA_TERMINAL_HANDLE: '',
      ORCA_WORKTREE_ID: '',
      ORCA_WORKSPACE_ID: ''
    },
    timeoutMs: 60_000
  })
  expect(result.code, result.stderr || result.stdout).toBe(0)
  const receipt = JSON.parse(result.stdout)
  expect(receipt.result.startupTerminal.title).toBe('Review tests')
  expect(receipt.result.agentTerminalHandle).toBe(receipt.result.startupTerminal.handle)
  const worktreeId: string = receipt.result.worktree.id
  const tabId: string = receipt.result.startupTerminal.tabId
  const ptyId: string = receipt.result.startupTerminal.ptyId

  await expect
    .poll(() =>
      page.evaluate(
        ({ worktreeId, tabId }) =>
          window.__store!.getState().tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
            ?.customTitle,
        { worktreeId, tabId }
      )
    )
    .toBe('Review tests')
  await page.evaluate(async (id) => {
    const state = window.__store!.getState()
    await state.fetchAllWorktrees()
    state.setActiveWorktree(id)
  }, worktreeId)
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await expect(tab).toContainText('Review tests')

  writeFileSync(changeMarker, 'change')
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const snapshot = await window.api.pty.getMainBufferSnapshot(id, { scrollbackRows: 200 })
        return snapshot?.data.includes('Agent OSC title updated')
      }, ptyId)
    )
    .toBe(true)
  await expect(tab).toContainText('Review tests')
  await expect
    .poll(() => {
      const persisted = parseWorkspaceSession(readPersistedProfileState(profile).workspaceSession)
      return persisted.ok
        ? persisted.value.tabsByWorktree[worktreeId]?.find((saved) => saved.id === tabId)
            ?.customTitle
        : undefined
    })
    .toBe('Review tests')
})
