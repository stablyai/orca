import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { resolveCliCommand } from '../../src/shared/node-cli-command-resolution'
import { createStructuredAgentSessionId } from '../../src/shared/structured-agent-session-create'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from '../../src/shared/structured-agent-session-mutation'
import { claudeSessionIdForOrcaSession } from '../../src/main/claude/claude-structured-session-id'

// Why skip Windows: the stub runs through a POSIX sh wrapper, a .cmd variant is unverified, and
// the full e2e suite runs on Linux CI only.
const SUPPORTED = process.platform !== 'win32'
const STUB_SCRIPT = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'structured-claude-stub.cjs'
)

const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

type ClaudeStub = { command: string; launchLog: string }

/** Dirs a login shell puts ahead of the launch PATH on macOS (path_helper). */
function macLoginShellPathDirs(): string[] {
  if (process.platform !== 'darwin') {
    return []
  }
  const files = [
    '/etc/paths',
    ...(existsSync('/etc/paths.d') ? readdirSync('/etc/paths.d') : []).map((name) =>
      path.join('/etc/paths.d', name)
    )
  ]
  return files.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean))
}

const test = base.extend<{ claudeStub: ClaudeStub }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  claudeStub: async ({}, provideFixture, testInfo) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-structured-claude-'))
    const command = path.join(dir, 'claude')
    const launchLog = path.join(dir, 'launches.jsonl')
    const emptyHome = path.join(dir, 'empty-home')
    mkdirSync(emptyHome)
    // Why: a login shell's PATH lands ahead of the launch PATH, and a PATH miss falls back to
    // install dirs; a real claude in any of those could be probed before the stub, so never launch.
    const shadowing = resolveCliCommand('claude', {
      pathEnv: [...SYSTEM_DIRS, ...macLoginShellPathDirs()].join(path.delimiter),
      homePath: emptyHome
    })
    if (path.isAbsolute(shadowing)) {
      rmSync(dir, { recursive: true, force: true })
      testInfo.skip(true, 'a system-wide claude would shadow the stub')
    }
    const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
    // Absolute node and stub paths, so the wrapper needs nothing from PATH to run.
    writeFileSync(
      command,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STUB_SCRIPT)} ${quote(launchLog)} "$@"\n`
    )
    chmodSync(command, 0o755)
    await provideFixture({ command, launchLog })
    rmSync(dir, { recursive: true, force: true })
  },
  launchEnv: async ({ claudeStub }, provideFixture) => {
    // Only the stub's directory and the system tool dirs: no user bin, Homebrew or npm prefix.
    await provideFixture({
      PATH: [path.dirname(claudeStub.command), ...SYSTEM_DIRS].join(path.delimiter)
    })
  }
})

type ChatTab = { id: string; entityId: string }

function readChatTabs(page: Page, worktreeId: string): Promise<ChatTab[]> {
  return page.evaluate(
    (wt) =>
      (window.__store?.getState().unifiedTabsByWorktree[wt] ?? [])
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => ({ id: tab.id, entityId: tab.entityId })),
    worktreeId
  )
}

async function waitForChatTab(page: Page, worktreeId: string, sessionId: string): Promise<string> {
  let tabId: string | undefined
  await expect
    .poll(
      async () => {
        tabId = (await readChatTabs(page, worktreeId)).find((tab) => tab.entityId === sessionId)?.id
        return tabId
      },
      { timeout: 30_000 }
    )
    .toBeTruthy()
  return tabId!
}

function tabInStrip(page: Page, tabId: string) {
  return page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
}

/** Creates a chat the way the CLI or a paired phone does: on the host, not in the window. */
async function createChatOnHost(page: Page, worktreeId: string): Promise<string> {
  const sessionId = createStructuredAgentSessionId('claude', randomUUID)
  const worktree = `id:${worktreeId}`
  const params = {
    envelope: {
      sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId,
        worktree,
        agent: 'claude'
      })
    },
    worktree,
    agent: 'claude'
  }
  const reply = await page.evaluate(
    (p) => window.api.runtime.call({ method: 'agentSession.create', params: p }),
    params
  )
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
  return sessionId
}

/** Every Claude process Orca started, as the stub recorded it. */
function readStubLaunches(launchLog: string): string[][] {
  if (!existsSync(launchLog)) {
    return []
  }
  return readFileSync(launchLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const entry: unknown = JSON.parse(line)
      if (typeof entry !== 'object' || entry === null || !('args' in entry)) {
        throw new Error(`unreadable stub launch: ${line}`)
      }
      return Array.isArray(entry.args) ? entry.args.map(String) : []
    })
}

test.describe('structured chat tabs', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('open from the host and the New tab menu, show in the tab bar, and close', async ({
    orcaPage: page,
    electronApp,
    claudeStub
  }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)
    // An absolute Command setting is used as-is or refuses the start; it never falls back.
    await page.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))

    const first = await createChatOnHost(page, worktreeId)
    const firstTab = await waitForChatTab(page, worktreeId, first)
    await expect(tabInStrip(page, firstTab)).toBeVisible()
    const second = await createChatOnHost(page, worktreeId)
    const secondTab = await waitForChatTab(page, worktreeId, second)
    await expect(tabInStrip(page, secondTab)).toBeVisible()
    await expect(tabInStrip(page, firstTab)).toBeVisible()

    // The window closes one chat from its tab; the host closes the other.
    await tabInStrip(page, firstTab).locator('[data-tab-close-button="true"]').click()
    await expect(tabInStrip(page, firstTab)).toHaveCount(0)
    await expect(tabInStrip(page, secondTab)).toBeVisible()
    const closed = await page.evaluate(
      ({ wt, tabId }) =>
        window.api.runtime.call({
          method: 'session.tabs.close',
          params: { worktree: `id:${wt}`, tabId, reason: 'user' }
        }),
      { wt: worktreeId, tabId: `agent-session:${second}` }
    )
    expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true })
    await expect(tabInStrip(page, secondTab)).toHaveCount(0)

    // A chat the window opens from the New tab menu.
    await page.getByRole('button', { name: 'New tab' }).click({ force: true })
    const claudeOption = page.getByRole('menuitem', { name: /^Claude(?:\s|$)/i }).first()
    await expect(claudeOption).toBeVisible({ timeout: 15_000 })
    await claudeOption.click({ force: true })
    let opened: ChatTab | undefined
    await expect
      .poll(
        async () => {
          opened = (await readChatTabs(page, worktreeId))[0]
          return opened?.entityId
        },
        { timeout: 30_000 }
      )
      .toBeTruthy()
    await expect(tabInStrip(page, opened!.id)).toBeVisible()

    // Orca's own lookup, on its shell-hydrated PATH and isolated HOME, lands on the stub.
    const mainEnv = await electronApp.evaluate(() => ({
      pathEnv: process.env.PATH ?? null,
      homePath: process.env.HOME
    }))
    expect(resolveCliCommand('claude', mainEnv)).toBe(claudeStub.command)
    // Every Claude process Orca started was the stub: a version probe, or a launch for one of
    // these chats' conversations.
    const providerIds = [first, second, opened!.entityId].map((id) =>
      claudeSessionIdForOrcaSession(id)
    )
    await expect.poll(() => readStubLaunches(claudeStub.launchLog).length).toBeGreaterThan(0)
    for (const args of readStubLaunches(claudeStub.launchLog)) {
      expect(
        args[0] === '--version' || providerIds.some((id) => args.includes(id)),
        JSON.stringify(args)
      ).toBe(true)
    }

    await tabInStrip(page, opened!.id).locator('[data-tab-close-button="true"]').click()
    await expect(tabInStrip(page, opened!.id)).toHaveCount(0)
  })
})
