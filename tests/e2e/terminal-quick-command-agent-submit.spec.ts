import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { openTerminalContextMenu } from './helpers/terminal-pane-title-actions'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'
import {
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type FakeAgentReport = {
  composerReady: boolean
  contractOk: boolean
  hasBracketedPasteFrame: boolean
  inputChunksHex: string[]
  inputHex: string
  markerReceived: boolean
  prematureEnters: number
  receivedEnters: number
  firstInputAtMs: number | null
  submitObservedAtMs: number | null
  submitted: boolean
}

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-quick-command-agent-submit-'))
const fixtureBin = path.join(fixtureRoot, 'bin')
const fixtureReport = path.join(fixtureRoot, 'report.json')
const fixtureMarker = `ORCA_QUICK_COMMAND_SUBMIT_${process.pid}`
const fixtureScript = path.join(process.cwd(), 'tests', 'tools', 'repro-terminal-send-submit.mjs')
const fakeCodex = path.join(fixtureBin, process.platform === 'win32' ? 'codex.cmd' : 'codex')
const prompt = `${fixtureMarker} ${'deterministic quick command payload '.repeat(16)}`
const normalizedPrompt = prompt.trim()
const expectStalled = process.env.ORCA_E2E_EXPECT_QUICK_COMMAND_STALLED === '1'

mkdirSync(fixtureBin)
if (process.platform === 'win32') {
  writeFileSync(
    fakeCodex,
    `@echo off\r\n"${process.execPath}" "${fixtureScript}" --fake-agent --report "${fixtureReport}" --marker "${fixtureMarker}" --negotiate-csi-u %*\r\n`,
    'utf8'
  )
} else {
  symlinkSync(process.execPath, fakeCodex)
}
const fakeCodexCommand =
  process.platform === 'win32'
    ? buildFakeAgentCommandOverride(fakeCodex)
    : `exec ${[
        fakeCodex,
        fixtureScript,
        '--fake-agent',
        '--report',
        fixtureReport,
        '--marker',
        fixtureMarker,
        '--negotiate-csi-u'
      ]
        .map((value) => buildFakeAgentCommandOverride(value))
        .join(' ')}`

test.use({
  orcaAppExtraEnv: {
    PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_E2E_DISABLE_QUICK_COMMAND_AGENT_PROTOCOL: expectStalled ? '1' : '0'
  }
})

test.afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function readReport(): FakeAgentReport | null {
  try {
    return JSON.parse(readFileSync(fixtureReport, 'utf8')) as FakeAgentReport
  } catch {
    return null
  }
}

test('Quick Command submits a settled prompt to an active Codex TUI', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(90_000)
  rmSync(fixtureReport, { force: true })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const tabId = await orcaPage.evaluate(
    async ({ fakeCodexCommand, prompt, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      const state = store.getState()
      await state.updateSettings({
        terminalQuickCommands: [
          {
            id: 'e2e-agent-submit',
            label: 'Submit deterministic prompt',
            scope: { type: 'global' },
            action: 'terminal-command',
            command: prompt,
            appendEnter: true
          }
        ]
      })
      const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: 'codex' })
      state.queueTabStartupCommand(tab.id, {
        command: fakeCodexCommand,
        launchAgent: 'codex',
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'tab_bar_quick_launch',
          request_kind: 'new'
        }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      return tab.id
    },
    { fakeCodexCommand, prompt, worktreeId }
  )

  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await expect
    .poll(() => getTerminalContent(orcaPage), { message: 'Fake Codex TUI did not render' })
    .toContain('OpenAI Codex')
  await expect
    .poll(() => orcaPage.evaluate((id) => window.api.pty.getForegroundProcess(id), ptyId), {
      message: 'Fake Codex process did not become the foreground PTY process'
    })
    .toMatch(/codex/i)
  await expect
    .poll(() => orcaPage.evaluate((id) => window.api.pty.confirmForegroundProcess(id), ptyId), {
      message: 'Fake Codex process did not receive fresh foreground confirmation'
    })
    .toMatch(/codex/i)
  const foregroundProbeTiming = await orcaPage.evaluate(async (id) => {
    const startedAt = performance.now()
    await window.api.pty.getForegroundProcess(id)
    const readAt = performance.now()
    await window.api.pty.confirmForegroundProcess(id)
    const confirmedAt = performance.now()
    return {
      confirmMs: confirmedAt - readAt,
      readMs: readAt - startedAt
    }
  }, ptyId)
  await installTerminalPtyWriteSpy(electronApp)
  await clearTerminalPtyWriteLog(electronApp)
  await orcaPage.evaluate(() => {
    const timingWindow = window as unknown as { __quickCommandClickAtMs?: number }
    timingWindow.__quickCommandClickAtMs = undefined
    const onClick = (event: Event): void => {
      const target = event.target as Element | null
      if (
        target?.closest('[role="menuitem"]')?.textContent?.includes('Submit deterministic prompt')
      ) {
        // Keep the marker in the same wall-clock domain as the PTY helper.
        timingWindow.__quickCommandClickAtMs = Date.now()
        document.removeEventListener('click', onClick, true)
      }
    }
    document.addEventListener('click', onClick, true)
  })

  await openTerminalContextMenu(orcaPage)
  await orcaPage.getByRole('menuitem', { name: 'Quick Commands' }).hover()
  await orcaPage.getByRole('menuitem', { name: 'Submit deterministic prompt' }).click()
  const clickDispatchedAtMs = await orcaPage.evaluate(
    () =>
      (window as unknown as { __quickCommandClickAtMs?: number }).__quickCommandClickAtMs ?? null
  )
  expect(clickDispatchedAtMs).not.toBeNull()

  await expect.poll(readReport, { message: 'Fake TUI did not emit a state report' }).not.toBeNull()
  const report = readReport()
  const writes = (await readTerminalPtyWriteEntries(electronApp))
    .filter((entry) => entry.id === ptyId)
    .map((entry) => entry.data)
  const receivedChunks = report?.inputChunksHex.map((hex) => Buffer.from(hex, 'hex').toString())
  console.log(
    JSON.stringify({
      tabId,
      ptyId,
      writes,
      receivedChunks,
      report,
      foregroundProbeTiming,
      timing: {
        clickToFirstInputMs:
          clickDispatchedAtMs === null ||
          report?.firstInputAtMs === null ||
          report?.firstInputAtMs === undefined
            ? null
            : report.firstInputAtMs - clickDispatchedAtMs,
        firstInputToSubmitMs:
          report?.firstInputAtMs === null ||
          report?.firstInputAtMs === undefined ||
          report?.submitObservedAtMs === null ||
          report?.submitObservedAtMs === undefined
            ? null
            : report.submitObservedAtMs - report.firstInputAtMs
      }
    })
  )

  if (expectStalled) {
    expect(report?.inputHex).toBe(Buffer.from(`${normalizedPrompt}\r`, 'utf8').toString('hex'))
    expect(receivedChunks?.join('')).toBe(`${normalizedPrompt}\r`)
    expect(report).toMatchObject({
      composerReady: false,
      contractOk: false,
      hasBracketedPasteFrame: false,
      markerReceived: true,
      prematureEnters: 1,
      receivedEnters: 0,
      submitted: false
    })
    await expect(getTerminalContent(orcaPage)).resolves.not.toContain(
      'ORCA_TERMINAL_SEND_REPORT ok'
    )
    return
  }

  // The fake TUI records the exact bytes observed on its PTY stdin. The main-process
  // IPC spy is intentionally only diagnostic here because settled runtime sends can
  // write directly through the provider rather than the renderer IPC channel.
  expect(report?.inputHex).toBe(
    Buffer.from(`\x1b[200~${normalizedPrompt}\x1b[201~\x1b[13u`, 'utf8').toString('hex')
  )
  // PTY data events may split one provider write; exact bytes and ordering are the E2E contract.
  expect(receivedChunks?.join('')).toBe(`\x1b[200~${normalizedPrompt}\x1b[201~\x1b[13u`)
  expect(report).toMatchObject({
    composerReady: true,
    contractOk: true,
    hasBracketedPasteFrame: true,
    markerReceived: true,
    prematureEnters: 0,
    receivedEnters: 1,
    submitted: true
  })
  await expect
    .poll(() => getTerminalContent(orcaPage), { message: 'Visible TUI submission marker missing' })
    .toContain('ORCA_TERMINAL_SEND_REPORT ok')
})
