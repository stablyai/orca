import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { emitCodexHookPayload, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { createMailPaneAgent } from './helpers/orchestration-mail-pane-agent'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('Codex only notifies for human approval and questions', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  // Intercept only OS display; retain the real hook, renderer, IPC, and delivery policy.
  await electronApp.evaluate(({ Notification }) => {
    const notifications: { title: string; body: string }[] = []
    Reflect.set(globalThis, '__codexApprovalNotifications', notifications)
    Notification.prototype.show = function () {
      notifications.push({ title: this.title, body: this.body })
      this.emit('show')
    }
  })
  const notifications = () =>
    electronApp.evaluate(() => Reflect.get(globalThis, '__codexApprovalNotifications'))

  const assertHidden = async () => {
    const windows = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    )
    expect(windows.length).toBeGreaterThan(0)
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
  }
  await assertHidden()
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const endpoint = await readHookEndpoint(electronApp)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)
  const agent = createMailPaneAgent()
  await sendToTerminal(orcaPage, ptyId, `${agent.launchCommand}\r`)
  await expect.poll(agent.hasStarted).toBe(true)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const transcriptPath = path.join(userDataPath, 'rollout-notification-smoke.jsonl')

  const beginTurn = async (turnId: string, reviewer: 'auto_review' | 'user') => {
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: turnId, approvals_reviewer: reviewer }
      })}\n`
    )
    await emitCodexHookPayload(endpoint, {
      ...descriptor,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        transcript_path: transcriptPath,
        turn_id: turnId,
        prompt: 'Codex approval notification smoke'
      }
    })
    await expect(orcaPage.getByLabel('Working', { exact: true }).first()).toBeVisible()
  }
  const emitTool = async (
    turnId: string,
    event: 'PreToolUse' | 'PermissionRequest',
    toolName: string,
    toolInput: Record<string, unknown>
  ) => {
    await emitCodexHookPayload(endpoint, {
      ...descriptor,
      payload: {
        hook_event_name: event,
        transcript_path: transcriptPath,
        turn_id: turnId,
        tool_name: toolName,
        tool_input: toolInput
      }
    })
  }

  await test.step('Automatic review remains working past the notification debounce', async () => {
    await beginTurn('auto-turn', 'auto_review')
    await emitTool('auto-turn', 'PreToolUse', 'Bash', { command: 'git status' })
    await emitTool('auto-turn', 'PermissionRequest', 'Bash', { command: 'git status' })
    // A slow automatic review must stay silent beyond the 1.5-second debounce.
    await orcaPage.waitForTimeout(6_000)
    await expect(orcaPage.getByLabel('Working', { exact: true }).first()).toBeVisible()
    await expect(orcaPage.getByLabel('Waiting for input', { exact: true })).toHaveCount(0)
    expect(await notifications()).toEqual([])
    await orcaPage.screenshot({ path: testInfo.outputPath('automatic-review.png') })
  })

  await test.step('Manual command approval reaches native notification display', async () => {
    await beginTurn('manual-turn', 'user')
    await emitTool('manual-turn', 'PermissionRequest', 'Bash', { command: 'git status' })
    await expect(orcaPage.getByLabel('Waiting for input', { exact: true }).first()).toBeVisible()
    await expect.poll(notifications).toEqual([
      {
        title: expect.stringContaining('Codex needs input'),
        body: expect.stringContaining('Bash')
      }
    ])
    await orcaPage.screenshot({ path: testInfo.outputPath('manual-approval.png') })
  })

  await test.step('A user question still notifies with automatic review enabled', async () => {
    // Allow the native worktree notification cooldown to expire.
    await orcaPage.waitForTimeout(5_500)
    await beginTurn('question-turn', 'auto_review')
    await emitTool('question-turn', 'PreToolUse', 'request_user_input', {
      questions: [{ id: 'scope', header: 'Scope', question: 'Which scope should I use?' }]
    })
    await expect(orcaPage.getByLabel('Waiting for input', { exact: true }).first()).toBeVisible()
    await expect.poll(notifications).toEqual([
      {
        title: expect.stringContaining('Codex needs input'),
        body: expect.stringContaining('Bash')
      },
      {
        title: expect.stringContaining('Codex needs input'),
        body: expect.stringContaining('request_user_input')
      }
    ])
    await orcaPage.screenshot({ path: testInfo.outputPath('user-question.png') })
  })
  await assertHidden()
  await testInfo.attach('native-notification-requests', {
    body: JSON.stringify(await notifications(), null, 2),
    contentType: 'application/json'
  })
})
