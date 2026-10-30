/**
 * A moved project's existing chats stay on this computer (owner decision, option C). Listing and
 * opening them is covered by wsl-move-moved-project-chats.spec.ts; this proves one still works:
 * a new message after the move runs the agent here, against the same files, and reaches no host.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { SUPPORTED, createChatOnHost } from './helpers/structured-claude-stub'
import { wslMoveCutoverFixture } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'

test.use({ seedTestRepo: false })

const STUB_SCRIPT = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'structured-claude-stub.cjs')
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** The Claude stub's wrapper; each launch appends its arguments to the log. */
function writeClaudeStub(dir: string): { command: string; launchLog: string } {
  const command = join(dir, 'claude')
  const launchLog = join(dir, 'launches.jsonl')
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  writeFileSync(
    command,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STUB_SCRIPT)} ${quote(launchLog)} "$@"\n`
  )
  chmodSync(command, 0o755)
  return { command, launchLog }
}

function launches(launchLog: string): { args: string[] }[] {
  return existsSync(launchLog)
    ? readFileSync(launchLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
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

test("a moved project's existing chat still answers here after the move", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')
  const root = mkdtempSync(join(tmpdir(), 'orca-wsl-moved-chat-send-'))
  const repoPath = join(root, 'moved-repo')
  mkdirSync(repoPath)
  const gitIdentity = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid']
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', [...gitIdentity, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: repoPath
  })
  const stub = writeClaudeStub(root)
  // Only the stub's directory and the system tool dirs, so no real Claude can answer.
  const session = createRestartSession(testInfo, {
    PATH: [dirname(stub.command), ...SYSTEM_DIRS].join(delimiter)
  })
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const repoId = await addRepo(launched.page, repoPath)
    const worktreeId = `${repoId}::${realpathSync(repoPath)}`
    await launched.page.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(stub.command))
    // The chat the project had before the move.
    const sessionId = await createChatOnHost(launched.page, worktreeId)
    await expect
      .poll(
        () =>
          launched!.page.evaluate(
            ({ worktreeId, sessionId }) =>
              (window.__store?.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.entityId === sessionId
              ),
            { worktreeId, sessionId }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await session.close(launched.app)
    launched = undefined

    seedWslMoveCutover(
      session.userDataDir,
      wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: [repoId] })
    )
    const launchesBefore = launches(stub.launchLog).length

    launched = await session.launch()
    const { page } = launched
    await waitForSessionReady(page)
    const entry = page.getByTestId('wsl-moved-project')
    await expect(entry).toBeVisible({ timeout: 30_000 })
    await entry.getByTestId('wsl-moved-chat').click()
    const chat = page.locator('[data-native-chat-root="true"]')
    const composer = chat.getByRole('textbox')
    await expect(composer).toBeEditable()
    await composer.click()
    await page.keyboard.type('hello after the move')
    await expect(composer).toContainText('hello after the move')
    await chat.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(chat.getByText('Stub reply.')).toBeVisible({ timeout: 30_000 })

    // The reply came from the agent this computer launched for the chat, after the move.
    expect(launches(stub.launchLog).length).toBeGreaterThan(launchesBefore)
    // No host: no environment was added, so nothing of the chat went to one.
    expect(
      await page.evaluate(async () => (await window.api.runtimeEnvironments.list()).length)
    ).toBe(0)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
