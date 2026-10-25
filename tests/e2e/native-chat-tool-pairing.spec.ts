import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test.use({
  minimumSeededWorktreeCount: 1,
  orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' }
})

const SILENT_CALL_COUNT = 32
const ACCEPTED_TASK = 'Keep the accepted task'
const REJECTED_TASK = 'Reject this failed replacement'
const COMMANDS = ['printf pairing_first', 'printf pairing_second', 'printf pairing_third']
const OUTPUTS = ['PAIR_OWNER_FIRST', 'PAIR_OWNER_SECOND', 'PAIR_OWNER_THIRD']

function pairingTranscript(sessionId: string): string {
  const calls = [
    ...Array.from({ length: SILENT_CALL_COUNT }, (_, index) => ({
      type: 'tool_use',
      id: `silent-${index}`,
      name: 'Bash',
      input: { command: `printf silent_${index}` }
    })),
    ...COMMANDS.map((command, index) => ({
      type: 'tool_use',
      id: `named-${index}`,
      name: 'Bash',
      input: { command }
    })),
    {
      type: 'tool_use',
      id: 'accepted-tasks',
      name: 'TodoWrite',
      input: { todos: [{ content: ACCEPTED_TASK, status: 'pending' }] }
    },
    {
      type: 'tool_use',
      id: 'rejected-tasks',
      name: 'TodoWrite',
      input: { todos: [{ content: REJECTED_TASK, status: 'completed' }] }
    }
  ]
  const results = [
    { type: 'tool_result', tool_use_id: 'outside-run', content: 'UNATTRIBUTED_OUTPUT' },
    ...OUTPUTS.map((output, index) => ({
      type: 'tool_result',
      tool_use_id: `named-${index}`,
      content: output
    })).toReversed(),
    { type: 'tool_result', tool_use_id: 'accepted-tasks', content: 'Tasks saved' },
    {
      type: 'tool_result',
      tool_use_id: 'rejected-tasks',
      content: 'Task update rejected',
      is_error: true
    }
  ]
  const records = [
    {
      sessionId,
      uuid: `${sessionId}-calls`,
      timestamp: new Date(Date.now() + 4_000).toISOString(),
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-opus-4', content: calls }
    },
    {
      sessionId,
      uuid: `${sessionId}-results`,
      timestamp: new Date(Date.now() + 6_000).toISOString(),
      type: 'user',
      message: { role: 'user', content: results }
    }
  ]
  return `${claudeTranscriptLines({
    sessionId,
    userText: 'Check tool output ownership behind silent calls',
    assistantText: 'Each named completion belongs to the command that produced it.'
  })}${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

test('keeps named output owners and accepted tasks while retaining a standalone orphan', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const launch = await electronApp.evaluate(({ app, BrowserWindow }) => ({
    appPath: app.getAppPath(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(launch.appPath).toBe(process.cwd())
  expect(launch.windows.length).toBeGreaterThan(0)
  expect(launch.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  const launchEvidence = testInfo.outputPath('hidden-launch-identity.json')
  writeFileSync(launchEvidence, JSON.stringify({ ...launch, processId: electronApp.process().pid }))
  await testInfo.attach('hidden-launch-identity', {
    path: launchEvidence,
    contentType: 'application/json'
  })

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-tool-pairing-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-tool-pairing-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)

  try {
    writeFileSync(transcriptPath, pairingTranscript(sessionId))
    await enableNativeChatSetting(orcaPage)
    await seedClaudeProviderSession(orcaPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId,
      transcriptPath
    })
    await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

    const chat = orcaPage.locator('[data-native-chat-root="true"]')
    await expect(chat).toBeVisible({ timeout: 15_000 })
    const runs = chat.locator('[data-native-chat-tool-run-state]')
    await expect(runs).toHaveCount(2, { timeout: 30_000 })
    const run = runs.first()
    await run.click()
    await expect(run).toHaveAttribute('aria-expanded', 'true')
    const members = chat.locator('[data-native-chat-tool-run-members]').first()
    await expect(members).toBeVisible()

    const silent = members.getByRole('button', { name: /printf silent_0$/ })
    await expect(silent).toBeVisible()
    await expect(silent).not.toHaveAttribute('aria-expanded', /true|false/)

    for (const [index, command] of COMMANDS.entries()) {
      const line = members.getByRole('button', { name: new RegExp(command) })
      await line.click()
      const detail = line.locator('..')
      await expect(detail.getByText(OUTPUTS[index]!, { exact: true })).toBeVisible()
      for (const other of OUTPUTS.filter((_, outputIndex) => outputIndex !== index)) {
        await expect(detail.getByText(other, { exact: true })).toHaveCount(0)
      }
    }
    await expect(members.getByRole('button', { name: /^Result\b/ })).toHaveCount(0)
    await expect(members.getByText('UNATTRIBUTED_OUTPUT', { exact: true })).toHaveCount(0)
    await members.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined))
      )
    })
    const outputsScreenshot = testInfo.outputPath('named-tool-outputs.png')
    await orcaPage.screenshot({ path: outputsScreenshot })
    await testInfo.attach('named-tool-outputs', {
      path: outputsScreenshot,
      contentType: 'image/png'
    })

    const taskToggle = chat.getByRole('button', { name: /Tasks.*0 of 1 tasks completed/ })
    await expect(taskToggle).toBeVisible()
    await taskToggle.click()
    const composerTaskList = taskToggle.locator('..').getByRole('list', { name: 'Tasks' })
    await expect(composerTaskList.getByText(ACCEPTED_TASK, { exact: true })).toBeVisible()
    await expect(composerTaskList.getByText(REJECTED_TASK, { exact: true })).toHaveCount(0)
    const tasksScreenshot = testInfo.outputPath('accepted-task-list.png')
    await orcaPage.screenshot({ path: tasksScreenshot })
    await testInfo.attach('accepted-task-list', {
      path: tasksScreenshot,
      contentType: 'image/png'
    })

    const orphanRun = runs.nth(1)
    await expect(orphanRun).toContainText('Result')
    await expect(orphanRun).not.toContainText('tool call')
    await orphanRun.click()
    await expect(orphanRun).toHaveAttribute('aria-expanded', 'true')
    const orphanMembers = chat.locator('[data-native-chat-tool-run-members]').nth(1)
    const orphan = orphanMembers.getByRole('button', { name: /^Result\b/ })
    await expect(orphan).toHaveCount(1)
    await orphan.click()
    await expect(orphan.locator('..').locator('pre[data-native-chat-code-content]')).toHaveText(
      'UNATTRIBUTED_OUTPUT'
    )
    for (const output of OUTPUTS) {
      await expect(orphanMembers.getByText(output, { exact: true })).toHaveCount(0)
    }
    await orphanMembers.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined))
      )
    })
    const orphanScreenshot = testInfo.outputPath('orphan-result-and-retained-tasks.png')
    await orcaPage.screenshot({ path: orphanScreenshot })
    await testInfo.attach('orphan-result-and-retained-tasks', {
      path: orphanScreenshot,
      contentType: 'image/png'
    })
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      )
    ).toBe(true)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
})
