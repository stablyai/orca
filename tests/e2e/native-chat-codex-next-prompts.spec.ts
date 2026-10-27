import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { createStructuredAgentSessionId } from '../../src/shared/structured-agent-session-create'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from '../../src/shared/structured-agent-session-mutation'

test.skip(process.platform === 'win32', 'POSIX test command wrapper')

const PROMPT = 'Review the changes for regressions'
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-next-prompts-e2e-'))
const command = path.join(scratch, 'codex')
const log = path.join(scratch, 'requests.jsonl')
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
writeFileSync(log, '')
writeFileSync(
  command,
  `#!/bin/sh\nexport ORCA_NEXT_PROMPTS_TEST_LOG=${quote(log)}\nexec ${quote(process.execPath)} ${quote(path.join(process.cwd(), 'tests/e2e/fixtures/codex-next-prompts-stub.cjs'))} "$@"\n`
)
chmodSync(command, 0o755)

test.use({
  launchEnv: { PATH: [scratch, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter) },
  orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' }
})

test('Codex next prompts fill the real editor without sending', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  await waitForSessionReady(page)
  await page.setViewportSize({ width: 1200, height: 760 })
  await page.evaluate(async () => {
    window.__store?.getState().markCodexTerminalServerIsolationNoticeSeen()
    await window.api.starNag.dismiss()
  })
  const worktreeId = await waitForActiveWorktree(page)
  await page.evaluate(async (override) => {
    await window.__store?.getState().updateSettings({
      experimentalNativeChat: true,
      defaultTuiAgent: 'codex',
      agentCmdOverrides: { codex: override }
    })
  }, buildFakeAgentCommandOverride(command))
  const sessionId = createStructuredAgentSessionId('codex', randomUUID)
  const worktree = `id:${worktreeId}`
  const created = await page.evaluate(
    (params) => window.api.runtime.call({ method: 'agentSession.create', params }),
    {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
        expectedRuntimeFence: null,
        payloadFingerprint: structuredAgentSessionCreateFingerprint({
          sessionId,
          worktree,
          agent: 'codex'
        })
      },
      worktree,
      agent: 'codex'
    }
  )
  expect(created).toMatchObject({ ok: true })
  await page.getByRole('button', { name: /^Codex Chat/ }).click()
  const root = page.locator('[data-native-chat-root="true"]')
  const editor = root.locator('[contenteditable="true"]').first()
  await expect(editor).toBeVisible({ timeout: 30_000 })
  const turnCount = (): number =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line && JSON.parse(line).method === 'turn/start').length
  for (const text of ['Review this example', 'Suggest a useful next step']) {
    await editor.fill(text)
    await editor.press('Enter')
    await expect.poll(turnCount, { timeout: 30_000 }).toBe(text.startsWith('Review') ? 1 : 2)
    await expect(root.getByText('The read-only review is complete.', { exact: true })).toHaveCount(
      turnCount()
    )
    if (turnCount() === 2) {
      await expect(root).toHaveAttribute('data-native-chat-working', 'true')
      await expect(root.getByText('orca-next-prompts', { exact: false })).toHaveCount(0)
      await expect(root.getByText(PROMPT, { exact: false })).toHaveCount(0)
      await root.screenshot({ path: testInfo.outputPath('04-streaming-hidden.png') })
      writeFileSync(`${log}.continue`, 'complete')
    }
    await expect(root).toHaveAttribute('data-native-chat-working', 'false', { timeout: 30_000 })
    if (turnCount() === 1) {
      await root.screenshot({ path: testInfo.outputPath('01-before.png') })
    }
  }
  const suggestion = root.getByRole('button', { name: PROMPT, exact: true })
  await expect(suggestion).toBeVisible()
  await expect(root.getByText('orca-next-prompts', { exact: false })).toHaveCount(0)
  await root.screenshot({ path: testInfo.outputPath('02-suggestion.png') })
  await suggestion.click()
  await expect(editor).toHaveText(PROMPT)
  await expect(editor).toBeFocused()
  await expect(suggestion).toHaveCount(0)
  // ast-grep-ignore: test-no-real-time-wait -- 保留延迟观察窗口，验证点击不会自动排队提交第三轮消息。
  await page.waitForTimeout(800)
  expect(turnCount()).toBe(2)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
  await root.screenshot({ path: testInfo.outputPath('03-unsent-draft.png') })
})

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})
