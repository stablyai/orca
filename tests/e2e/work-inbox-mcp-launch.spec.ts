import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { setAppEnvironment } from '../../src/shared/app-environment'
import { workInboxCliServer } from '../../src/main/runtime/work-inbox/work-inbox-cli-launch'

test.use({ seedTestRepo: false })
test('the generated MCP launcher reaches the same desktop question and cancellation', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const project = testInfo.outputPath('project')
  await mkdir(project, { recursive: true })
  const handle = await orcaPage.evaluate(async (path) => {
    const result = await window.api.repos.add({ path, kind: 'folder' })
    if ('error' in result) {
      throw new Error(result.error)
    }
    await window.__store!.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
    await window.__store!.getState().fetchWorktrees(result.repo.id)
    const workspace = window.__store!.getState().worktreesByRepo[result.repo.id]?.[0]
    if (!workspace) {
      throw new Error('No isolated workspace')
    }
    const created = await window.api.runtime.call({
      method: 'terminal.create',
      params: { worktree: `id:${workspace.id}`, focus: false, activate: false }
    })
    if (
      !created.ok ||
      !created.result ||
      typeof created.result !== 'object' ||
      !('terminal' in created.result) ||
      !created.result.terminal ||
      typeof created.result.terminal !== 'object' ||
      !('handle' in created.result.terminal) ||
      typeof created.result.terminal.handle !== 'string'
    ) {
      throw new Error('No isolated terminal')
    }
    return created.result.terminal.handle
  }, project)
  const profile = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  setAppEnvironment({
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  const server = workInboxCliServer({ ORCA_TERMINAL_HANDLE: handle })
  const transport = new StdioClientTransport({
    ...server,
    env: {
      ...server.env,
      PATH: process.env.PATH ?? '',
      HOME: profile,
      USERPROFILE: profile,
      APPDATA: process.env.APPDATA ?? '',
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? ''
    },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'isolated-launch-contract', version: '1' })
  try {
    await client.connect(transport)
    const asked = await client.callTool({
      name: 'ask_user',
      arguments: {
        request_id: randomUUID(),
        question: 'Question from the generated MCP launcher',
        options: ['Approve', 'Reject'],
        timeout_ms: 1000
      }
    })
    expect(asked.isError).not.toBe(true)
    const item = asked.structuredContent
    if (!item || typeof item.id !== 'string') {
      throw new Error('No MCP question ID')
    }
    await orcaPage.getByRole('button', { name: 'Work Inbox', exact: true }).click()
    await orcaPage.getByRole('button', { name: 'Refresh', exact: true }).click()
    const card = orcaPage
      .locator('article')
      .filter({ hasText: 'Question from the generated MCP launcher' })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Close without answering' }).click()
    const closed = await client.callTool({
      name: 'wait_for_answer',
      arguments: { question_id: item.id, timeout_ms: 1000 }
    })
    expect(closed.structuredContent).toMatchObject({ id: item.id, cancelled: true, answer: null })
    expect(closed.structuredContent?.nextAction).toContain('not approval')
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    await client.close()
    await transport.close()
  }
})
