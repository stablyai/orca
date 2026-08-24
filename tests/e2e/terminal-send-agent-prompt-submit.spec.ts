import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { parsePairingCode } from '../../src/shared/pairing'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest
} from '../../src/shared/remote-runtime-client'

const execFileAsync = promisify(execFile)
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-send-agent-prompt-'))
const fixtureBin = path.join(fixtureRoot, 'bin')
const fixtureReport = path.join(fixtureRoot, 'report.json')
const fixtureInputObservation = path.join(fixtureRoot, 'input.bin')
const fixtureMarker = `ORCA_TERMINAL_SEND_E2E_${process.pid}`
const fixtureScript = path.join(process.cwd(), 'tests', 'tools', 'repro-terminal-send-submit.mjs')
const fakeCodex = path.join(fixtureBin, process.platform === 'win32' ? 'codex.cmd' : 'codex')

mkdirSync(fixtureBin)
if (process.platform === 'win32') {
  writeFileSync(
    fakeCodex,
    `@echo off\r\n"${process.execPath}" "${fixtureScript}" --fake-agent --report "%ORCA_FAKE_AGENT_REPORT%" --marker "%ORCA_FAKE_AGENT_MARKER%" --input-observation "%ORCA_FAKE_AGENT_INPUT_OBSERVATION%" --allow-unframed-paste %*\r\n`,
    'utf8'
  )
} else {
  symlinkSync(process.execPath, fakeCodex)
}
const fakeCodexCommand =
  process.platform === 'win32'
    ? `"${fakeCodex}"`
    : `${shellQuote(fakeCodex)} ${shellQuote(fixtureScript)} --fake-agent --report ${shellQuote(fixtureReport)} --marker ${shellQuote(fixtureMarker)} --input-observation ${shellQuote(fixtureInputObservation)}`

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: {
    PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_FAKE_AGENT_REPORT: fixtureReport,
    ORCA_FAKE_AGENT_MARKER: fixtureMarker,
    ORCA_FAKE_AGENT_INPUT_OBSERVATION: fixtureInputObservation
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
        fakeCodexCommand,
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
        `${fakeCodexCommand} --swallow-first-enter`,
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

test('paired mobile floor takeover blocks the CLI delayed Enter', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(90_000)
  await waitForSessionReady(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const marker = fixtureMarker
  rmSync(fixtureReport, { force: true })
  rmSync(fixtureInputObservation, { force: true })
  const worktreeSelector = await resolveTestWorktreeSelector(testRepoPath, userDataDir)
  const created = await callDevCli(
    [
      'terminal',
      'create',
      '--worktree',
      worktreeSelector,
      '--title',
      'paired mobile prompt authority',
      '--command',
      `${fakeCodexCommand} --timeout-ms 60000`
    ],
    testRepoPath,
    userDataDir
  )
  const terminal = created.terminal as { handle: string }
  const shown = await callDevCli(
    ['terminal', 'show', '--terminal', terminal.handle],
    testRepoPath,
    userDataDir
  )
  const ptyId = (shown.terminal as { ptyId: string }).ptyId
  await expect
    .poll(async () => {
      const ready = await callDevCli(
        ['terminal', 'show', '--terminal', terminal.handle],
        testRepoPath,
        userDataDir
      )
      return (ready.terminal as { preview?: string }).preview
    })
    .toContain('OpenAI Codex')

  const pairingResult = await orcaPage.evaluate(() =>
    window.api.mobile.getPairingQR({
      address: '127.0.0.1',
      connectionMode: 'local-only',
      rotate: true
    })
  )
  expect(pairingResult.available).toBe(true)
  if (!pairingResult.available) {
    throw new Error('Mobile pairing unavailable')
  }
  const pairing = parsePairingCode(pairingResult.pairingUrl)
  expect(pairing).toBeTruthy()
  if (!pairing) {
    throw new Error('Mobile pairing URL did not parse')
  }

  const responses: Record<string, unknown>[] = []
  const subscription = await subscribeRemoteRuntimeRequest(
    pairing,
    'terminal.subscribe',
    {
      terminal: terminal.handle,
      client: { id: pairing.deviceToken, type: 'mobile' },
      viewport: { cols: 45, rows: 20 },
      capabilities: { terminalBinaryStream: 1 }
    },
    15_000,
    {
      onResponse: (response) => responses.push(response as unknown as Record<string, unknown>),
      onError: (error) => {
        throw error
      }
    }
  )

  try {
    await expect
      .poll(() =>
        responses.some(
          (response) => (response.result as { type?: string } | undefined)?.type === 'subscribed'
        )
      )
      .toBe(true)
    await expectTerminalDriver(orcaPage, ptyId, 'mobile')
    await expect(
      orcaPage.evaluate((id) => window.api.runtime.restoreTerminalFit(id), ptyId)
    ).resolves.toEqual({ restored: true })
    await expectTerminalDriver(orcaPage, ptyId, 'desktop')
    const beforeSend = await callDevCli(
      ['terminal', 'show', '--terminal', terminal.handle],
      testRepoPath,
      userDataDir
    )
    expect(beforeSend.terminal).toMatchObject({ connected: true, writable: true, ptyId })

    const prompt = `${marker} paired owner payload`
    let desktopSendOutcome: unknown
    const desktopSend = callDevCli(
      ['terminal', 'send', '--terminal', terminal.handle, '--text', prompt, '--enter'],
      testRepoPath,
      userDataDir
    )
    void desktopSend.then(
      (value) => {
        desktopSendOutcome = value
      },
      (error) => {
        desktopSendOutcome = error
      }
    )
    await expect
      .poll(
        () =>
          readObservedInput(fixtureInputObservation).includes(marker) ||
          desktopSendOutcome !== undefined
      )
      .toBe(true)
    if (!readObservedInput(fixtureInputObservation).includes(marker)) {
      const drivers = await orcaPage.evaluate(() => window.api.runtime.getTerminalDrivers())
      throw new Error(
        `Desktop send settled before paste: ${JSON.stringify(desktopSendOutcome)}; drivers=${JSON.stringify(drivers)}`
      )
    }

    const mobileSend = await sendRemoteRuntimeRequest<{
      send: { accepted: boolean; bytesWritten: number }
    }>(
      pairing,
      'terminal.send',
      {
        terminal: terminal.handle,
        text: 'mobile-owner-input',
        client: { id: pairing.deviceToken, type: 'mobile' }
      },
      15_000
    )
    expect(mobileSend.ok).toBe(true)
    if (!mobileSend.ok) {
      throw new Error(mobileSend.error.message)
    }
    expect(mobileSend).toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    await expectTerminalDriver(orcaPage, ptyId, 'mobile')

    await expect(desktopSend).resolves.toMatchObject({
      send: { accepted: false, bytesWritten: 0 }
    })
    const observedInput = readObservedInput(fixtureInputObservation)
    const desktopFrame = process.platform === 'win32' ? prompt : `\x1b[200~${prompt}\x1b[201~`
    expect(observedInput).toBe(`${desktopFrame}mobile-owner-input`)
  } finally {
    subscription.close()
    await callDevCli(
      ['terminal', 'close', '--terminal', terminal.handle],
      testRepoPath,
      userDataDir
    )
  }
})

async function resolveTestWorktreeSelector(
  testRepoPath: string,
  userDataDir: string
): Promise<string> {
  const added = await callDevCli(['repo', 'add', '--path', testRepoPath], testRepoPath, userDataDir)
  const repoId = (added.repo as { id: string }).id
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const listed = await callDevCli(
      ['worktree', 'list', '--repo', `id:${repoId}`],
      testRepoPath,
      userDataDir
    )
    const worktree = (listed.worktrees as { id: string; path: string }[]).find(
      (candidate) => path.resolve(candidate.path) === path.resolve(testRepoPath)
    )
    if (worktree) {
      return `id:${worktree.id}`
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Test worktree did not materialize for ${repoId}`)
}

async function callDevCli(
  args: string[],
  cwd: string,
  userDataDir: string
): Promise<Record<string, unknown>> {
  let result: { stdout: string; stderr: string }
  try {
    result = await execFileAsync(
      process.execPath,
      [path.join(process.cwd(), 'config', 'scripts', 'orca-dev.mjs'), ...args, '--json'],
      {
        cwd,
        env: { ...process.env, ORCA_DEV_USER_DATA_PATH: userDataDir },
        timeout: 60_000
      }
    )
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string }
    throw new Error([failed.message, failed.stdout, failed.stderr].filter(Boolean).join('\n'))
  }
  const response = JSON.parse(result.stdout) as {
    ok: boolean
    result?: Record<string, unknown>
    error?: { message?: string }
  }
  if (!response.ok || !response.result) {
    throw new Error(response.error?.message ?? 'Orca CLI request failed')
  }
  return response.result
}

async function expectTerminalDriver(
  page: Page,
  ptyId: string,
  kind: 'desktop' | 'mobile'
): Promise<void> {
  await expect
    .poll(async () => {
      const drivers = await page.evaluate(() => window.api.runtime.getTerminalDrivers())
      return drivers.find((entry) => entry.ptyId === ptyId)?.driver.kind
    })
    .toBe(kind)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function readObservedInput(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}
