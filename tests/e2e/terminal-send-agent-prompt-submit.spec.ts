import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from './helpers/orca-app'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { waitForSessionReady } from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { recognizeAgentProcess } from '../../src/shared/agent-process-recognition'
import { SWALLOWED_ENTER_FIXTURE_TIMEOUT_MS } from '../../src/shared/orchestration-timing-budgets'

const execFileAsync = promisify(execFile)
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-send-agent-prompt-'))
const fixtureReport = path.join(fixtureRoot, 'report.json')
const fixtureMarker = `ORCA_TERMINAL_SEND_E2E_${process.pid}`
const fixtureScript = path.join(process.cwd(), 'tests', 'tools', 'repro-terminal-send-submit.mjs')
const fakeCodex = path.join(fixtureRoot, process.platform === 'win32' ? 'codex.cmd' : 'codex')
const fakeCodexCommand = buildFakeAgentCommandOverride(fakeCodex)
const swallowedEnterFixtureTimeoutMs = SWALLOWED_ENTER_FIXTURE_TIMEOUT_MS

writeFileSync(
  fakeCodex,
  process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixtureScript}" --fake-agent --report "%ORCA_FAKE_AGENT_REPORT%" --marker "%ORCA_FAKE_AGENT_MARKER%" --allow-unframed-paste %*\r\n`
    : `#!/usr/bin/env sh\n"${process.execPath}" "${fixtureScript}" --fake-agent --report "$ORCA_FAKE_AGENT_REPORT" --marker "$ORCA_FAKE_AGENT_MARKER" "$@"\n`,
  'utf8'
)
if (process.platform !== 'win32') {
  chmodSync(fakeCodex, 0o755)
}

test.afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

async function createFakeCodexTerminal(
  userDataDir: string,
  testRepoPath: string,
  args: string[] = []
): Promise<string> {
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const expectedPath = path.resolve(testRepoPath)
  const findWorktree = async (): Promise<{ id: string } | undefined> => {
    const listed = await client.call<{ worktrees: { id: string; path: string }[] }>(
      'worktree.list',
      {}
    )
    return listed.result.worktrees.find((worktree) => {
      const candidatePath = path.resolve(worktree.path)
      return process.platform === 'win32'
        ? candidatePath.toLowerCase() === expectedPath.toLowerCase()
        : candidatePath === expectedPath
    })
  }
  await expect.poll(async () => Boolean(await findWorktree()), { timeout: 60_000 }).toBe(true)
  const worktree = await findWorktree()
  if (!worktree) {
    throw new Error(`runtime did not register ${testRepoPath}`)
  }
  const created = await client.call<{ terminal: { handle: string } }>('terminal.create', {
    worktree: `id:${worktree.id}`,
    command: [fakeCodexCommand, ...args].join(' '),
    launchAgent: 'codex',
    env: {
      ORCA_FAKE_AGENT_REPORT: fixtureReport,
      ORCA_FAKE_AGENT_MARKER: fixtureMarker
    },
    title: 'terminal send submit repro'
  })
  const handle = created.result.terminal.handle
  await expect
    .poll(
      async () => {
        const inspected = await client.call<{
          process: { foregroundProcess: string | null }
        }>('terminal.inspectProcess', { terminal: handle })
        return recognizeAgentProcess(inspected.result.process.foregroundProcess)?.agent ?? null
      },
      { timeout: 30_000 }
    )
    .toBe('codex')
  return handle
}

test('CLI text plus Enter waits for a slow agent composer before submitting', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(110_000)
  await waitForSessionReady(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const terminal = await createFakeCodexTerminal(userDataDir, testRepoPath)
  const repoRoot = process.cwd()
  let stdout = ''
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, 'tests', 'tools', 'repro-terminal-send-submit.mjs'),
        '--cli',
        path.join(repoRoot, 'config', 'scripts', 'orca-dev.mjs'),
        '--worktree',
        testRepoPath,
        '--terminal',
        terminal,
        '--report',
        fixtureReport,
        '--marker',
        fixtureMarker,
        '--discard-report'
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ORCA_DEV_USER_DATA_PATH: userDataDir },
        timeout: 60_000
      }
    )
    stdout = result.stdout
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string }
    throw new Error([failed.message, failed.stdout, failed.stderr].filter(Boolean).join('\n'))
  }

  expect(JSON.parse(stdout)).toMatchObject({
    rescueSent: false,
    contractOk: true,
    submitted: true,
    prematureEnters: 0,
    pasteFramingRequired: process.platform !== 'win32',
    ...(process.platform === 'win32' ? {} : { hasBracketedPasteFrame: true }),
    markerReceived: true
  })
})

test('CLI reports a swallowed Enter without submitting a second Enter', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(110_000)
  await waitForSessionReady(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const terminal = await createFakeCodexTerminal(userDataDir, testRepoPath, [
    '--swallow-first-enter',
    '--timeout-ms',
    String(swallowedEnterFixtureTimeoutMs)
  ])
  const repoRoot = process.cwd()
  let stdout = ''
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, 'tests', 'tools', 'repro-terminal-send-submit.mjs'),
        '--cli',
        path.join(repoRoot, 'config', 'scripts', 'orca-dev.mjs'),
        '--worktree',
        testRepoPath,
        '--terminal',
        terminal,
        '--timeout-ms',
        String(swallowedEnterFixtureTimeoutMs),
        '--expect-stalled',
        '--report',
        fixtureReport,
        '--marker',
        fixtureMarker,
        '--discard-report'
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ORCA_DEV_USER_DATA_PATH: userDataDir },
        timeout: 90_000
      }
    )
    stdout = result.stdout
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string }
    throw new Error([failed.message, failed.stdout, failed.stderr].filter(Boolean).join('\n'))
  }

  expect(JSON.parse(stdout)).toMatchObject({
    rescueSent: false,
    sendErrorCode: 'agent_prompt_stalled',
    contractOk: true,
    submitted: false,
    prematureEnters: 0,
    receivedEnters: 1,
    swallowedEnters: 1,
    configuredTimeoutMs: swallowedEnterFixtureTimeoutMs,
    markerReceived: true
  })
})

test('CLI does not write prompt bytes into an active permission dialog', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(110_000)
  await waitForSessionReady(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const terminal = await createFakeCodexTerminal(userDataDir, testRepoPath, [
    '--permission-before-send'
  ])
  const repoRoot = process.cwd()
  let stdout = ''
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, 'tests', 'tools', 'repro-terminal-send-submit.mjs'),
        '--cli',
        path.join(repoRoot, 'config', 'scripts', 'orca-dev.mjs'),
        '--worktree',
        testRepoPath,
        '--terminal',
        terminal,
        '--expect-blocked',
        '--report',
        fixtureReport,
        '--marker',
        fixtureMarker,
        '--discard-report'
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ORCA_DEV_USER_DATA_PATH: userDataDir },
        timeout: 60_000
      }
    )
    stdout = result.stdout
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string }
    throw new Error([failed.message, failed.stdout, failed.stderr].filter(Boolean).join('\n'))
  }

  expect(JSON.parse(stdout)).toMatchObject({
    rescueSent: false,
    sendErrorCode: 'agent_prompt_blocked',
    contractOk: true,
    submitted: false,
    receivedBytes: 0,
    receivedEnters: 0,
    markerReceived: false
  })
})
