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
import { test as base } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import { resolveCliCommand } from '../../../../src/shared/shell/command-resolution/node-cli-command-resolution'
import { createOrcaSessionId } from '../../../../src/shared/agent-session/identity/orca-session-address'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from '../../../../src/shared/agent-session/lifecycle/operations/structured-agent-session-mutation'

// Skip Windows until the POSIX stub wrapper has a verified .cmd equivalent.
export const SUPPORTED = process.platform !== 'win32'
const STUB_SCRIPT = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'structured-claude-stub.cjs'
)

const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

export type ClaudeStub = {
  command: string
  launchLog: string
  /** Each user message the stub was sent, one JSON line per turn. */
  inputLog: string
}

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

/** Writes the stub `claude` into `dir`; null when a system-wide claude would shadow it on PATH. */
export function writeClaudeStub(dir: string): ClaudeStub | null {
  const command = path.join(dir, 'claude')
  const launchLog = path.join(dir, 'launches.jsonl')
  const inputLog = path.join(dir, 'launches-inputs.jsonl')
  const emptyHome = path.join(dir, 'empty-home')
  mkdirSync(emptyHome)
  // Refuse launch if login-shell PATH or fallback install dirs could select real Claude before the stub.
  const shadowing = resolveCliCommand('claude', {
    pathEnv: [...SYSTEM_DIRS, ...macLoginShellPathDirs()].join(path.delimiter),
    homePath: emptyHome
  })
  if (path.isAbsolute(shadowing)) {
    return null
  }
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  writeFileSync(
    command,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STUB_SCRIPT)} ${quote(launchLog)} "$@"\n`
  )
  chmodSync(command, 0o755)
  return { command, launchLog, inputLog }
}

/** Only the stub's directory and the system tool dirs: no user bin, Homebrew or npm prefix. */
export function claudeStubPath(stub: ClaudeStub): string {
  return [path.dirname(stub.command), ...SYSTEM_DIRS].join(path.delimiter)
}

export const test = base.extend<{ claudeStub: ClaudeStub }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  claudeStub: async ({}, provideFixture, testInfo) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-structured-claude-'))
    const stub = writeClaudeStub(dir)
    if (!stub) {
      rmSync(dir, { recursive: true, force: true })
      testInfo.skip(true, 'a system-wide claude would shadow the stub')
      return
    }
    await provideFixture(stub)
    rmSync(dir, { recursive: true, force: true })
  },
  launchEnv: async ({ claudeStub }, provideFixture) => {
    await provideFixture({ PATH: claudeStubPath(claudeStub) })
  }
})

/** Creates a chat the way the CLI or a paired phone does: on the host, not in the window. */
export async function createChatOnHost(
  page: Page,
  worktreeId: string,
  agent: 'claude' | 'omp' = 'claude'
): Promise<string> {
  const sessionId = createOrcaSessionId(randomUUID)
  const worktree = `id:${worktreeId}`
  const params = {
    envelope: {
      sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId,
        worktree,
        agent
      })
    },
    worktree,
    agent
  }
  const reply = await page.evaluate(
    (p) => window.api.runtime.call({ method: 'agentSession.create', params: p }),
    params
  )
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
  return sessionId
}

/** Open a chat tab driven by the Claude stub and focus its composer. */
export async function openStubChat(page: Page, claudeCommand: string) {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await page.evaluate(async (command) => {
    await window.__store?.getState().updateSettings({
      nativeChatProviders: { claude: true, codex: true },
      defaultTuiAgent: 'claude',
      agentCmdOverrides: { claude: command }
    })
  }, buildFakeAgentCommandOverride(claudeCommand))
  const sessionId = await createChatOnHost(page, worktreeId)
  const readTabId = () =>
    page.evaluate(
      ({ worktreeId, sessionId }) =>
        window.__store
          ?.getState()
          .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id,
      { worktreeId, sessionId }
    )
  await expect.poll(readTabId, { timeout: 30_000 }).toBeTruthy()
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${await readTabId()}"]`)
  await tab.click()
  const chat = page.locator('[data-native-chat-root="true"]')
  const composer = chat.getByRole('textbox')
  await composer.click()
  return {
    tab,
    composer,
    send: chat.getByRole('button', { name: 'Send', exact: true }),
    stop: chat.getByRole('button', { name: 'Stop the agent' }),
    reply: chat.getByText('Stub reply.')
  }
}
