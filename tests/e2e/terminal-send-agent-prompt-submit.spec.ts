import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const execFileAsync = promisify(execFile)
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-send-agent-prompt-'))
const fixtureBin = path.join(fixtureRoot, 'bin')
const fixtureReport = path.join(fixtureRoot, 'report.json')
const fixtureMarker = `ORCA_TERMINAL_SEND_E2E_${process.pid}`
const fixtureScript = path.join(process.cwd(), 'tests', 'tools', 'repro-terminal-send-submit.mjs')
const fakeCodex = path.join(fixtureBin, process.platform === 'win32' ? 'codex.cmd' : 'codex')

mkdirSync(fixtureBin)
writeFileSync(
  fakeCodex,
  process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixtureScript}" --fake-agent --report "%ORCA_FAKE_AGENT_REPORT%" --marker "%ORCA_FAKE_AGENT_MARKER%" --allow-unframed-paste %*\r\n`
    : `#!/usr/bin/env sh\nexec "${process.execPath}" "${fixtureScript}" --fake-agent --report "$ORCA_FAKE_AGENT_REPORT" --marker "$ORCA_FAKE_AGENT_MARKER" "$@"\n`,
  'utf8'
)
if (process.platform !== 'win32') {
  chmodSync(fakeCodex, 0o755)
}

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: {
    PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_FAKE_AGENT_REPORT: fixtureReport,
    ORCA_FAKE_AGENT_MARKER: fixtureMarker
  }
})

test.afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

test('CLI text plus Enter waits for a slow agent composer before submitting', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(90_000)
  await waitForSessionReady(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
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
        '--agent-command',
        'codex',
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
  test.setTimeout(90_000)
  await waitForSessionReady(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
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
        '--agent-command',
        'codex --swallow-first-enter',
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
    sendErrorCode: 'agent_prompt_stalled',
    contractOk: true,
    submitted: false,
    prematureEnters: 0,
    receivedEnters: 1,
    swallowedEnters: 1,
    markerReceived: true
  })
})

test('CLI does not write prompt bytes into an active permission dialog', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(90_000)
  await waitForSessionReady(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
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
