import { describe, expect, test } from 'vitest'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerSnapshotResult
} from '../../src/shared/runtime-types'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  ensureOrcaRuntimeLaunched,
  parseJsonOutput,
  runOrcaCli,
  stopOrcaRuntime
} from './helpers/computer-driver'
import {
  buildCloseSettingsArgs,
  buildGetSettingsStateArgs,
  findSettingsSearchEchoLines,
  parseElementLineIndex,
  parseSettingsCloseOutput,
  parseSettingsLaunchOutput,
  requireUniqueSettingsSearchBoxIndex,
  selectSettingsSearchBoxLine,
  type SettingsFrame
} from './helpers/windows-settings-frame'

const execFileAsync = promisify(execFile)

const isWindows = process.platform === 'win32'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'

// Nonsense query that cannot match any Settings entry on any locale.
const SEARCH_PROBE = 'zzqq7391'
const SEARCH_POLL_INTERVAL_MS = 500
const SEARCH_POLL_DEADLINE_MS = 15_000

// Settings is single-instance UWP. This file assumes an isolated CI session:
// do not run in parallel with other UWP e2e, and expect teardown to close
// any pre-existing Settings window in the same session.
describe.skipIf(!isWindows || !e2eOptIn)('computer-use Windows e2e (Store apps)', () => {
  test(
    'Store app windows are discoverable and attachable by pid',
    { timeout: 120_000 },
    async () => {
      await withSettingsFrame(async (frame) => {
        const apps = parseJsonOutput<{ result: ComputerListAppsResult }>(
          (await runOrcaCli(['computer', 'list-apps', '--json'])).stdout
        )
        expect(apps.result.apps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ bundleId: 'ApplicationFrameHost', pid: frame.FramePid })
          ])
        )
        const state = parseJsonOutput<{ result: ComputerSnapshotResult }>(
          (await runOrcaCli(buildGetSettingsStateArgs(frame))).stdout
        )
        // Ensure the snapshot returned belongs to our targeted app
        expect(state.result.snapshot.app.pid).toBe(frame.FramePid)
        expect(state.result.snapshot.treeText.length).toBeGreaterThan(0)
      })
    }
  )

  test('Store app elements are clickable and accept typed text', { timeout: 120_000 }, async () => {
    await withSettingsFrame(async (frame) => {
      const app = `pid:${frame.FramePid}`
      const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
        (await runOrcaCli(buildGetSettingsStateArgs(frame))).stdout
      ).result.snapshot.treeText
      const searchIndex = requireUniqueSettingsSearchBoxIndex(before)

      const clicked = parseJsonOutput<{ result: ComputerActionResult }>(
        (
          await runOrcaCli([
            'computer',
            'click',
            '--app',
            app,
            '--element-index',
            String(searchIndex),
            '--restore-window',
            '--no-screenshot',
            '--json'
          ])
        ).stdout
      )
      // Pin the ACT path: synthetic input, not an accessibility call.
      expect(clicked.result.action?.path).toBe('synthetic')

      const typed = parseJsonOutput<{ result: ComputerActionResult }>(
        (
          await runOrcaCli([
            'computer',
            'type-text',
            '--app',
            app,
            '--text',
            SEARCH_PROBE,
            '--restore-window',
            '--no-screenshot',
            '--json'
          ])
        ).stdout
      )
      expect(typed.result.action?.path).toBe('synthetic')

      await pollForSearchEchoes(frame)
    })
  })
})

const settingsFrameScript = join(__dirname, 'helpers', 'Invoke-SettingsApplicationFrame.ps1')

async function runSettingsFrameScript(scriptArgs: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Sta',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      settingsFrameScript,
      ...scriptArgs
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: timeoutMs
    }
  )
  return stdout
}

async function launchSettingsApp(): Promise<SettingsFrame> {
  const stdout = await runSettingsFrameScript(
    ['-Action', 'Launch', '-TimeoutMilliseconds', '15000'],
    45000
  )
  return parseSettingsLaunchOutput(stdout)
}

async function closeSettingsFrame(frame: SettingsFrame): Promise<void> {
  const stdout = await runSettingsFrameScript(buildCloseSettingsArgs(frame), 30000)
  const result = parseSettingsCloseOutput(stdout)
  if (result.Status !== 'Closed' && result.Status !== 'AlreadyGone') {
    throw new Error(
      `Settings frame ${frame.FrameHwnd} teardown returned status "${result.Status}" (identity mismatch or failure).`
    )
  }
}

// Shared lifecycle: identity-checked teardown aggregates its failures instead
// of masking the primary assertion error.
async function withSettingsFrame(body: (frame: SettingsFrame) => Promise<void>): Promise<void> {
  let frame: SettingsFrame | undefined
  let primaryError: unknown
  let hasPrimaryError = false

  try {
    await ensureOrcaRuntimeLaunched()
    frame = await launchSettingsApp()
    await body(frame)
  } catch (error) {
    hasPrimaryError = true
    primaryError = error
  }

  const cleanupErrors: unknown[] = []

  if (frame) {
    try {
      await closeSettingsFrame(frame)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  try {
    await stopOrcaRuntime()
  } catch (error) {
    cleanupErrors.push(error)
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'The E2E test and its cleanup both failed'
      )
    }
    throw primaryError
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'E2E cleanup failed')
  }
}

async function pollForSearchEchoes(frame: SettingsFrame): Promise<void> {
  const deadline = Date.now() + SEARCH_POLL_DEADLINE_MS
  let lastDiagnostics = '(no snapshot taken)'

  for (;;) {
    const treeText = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runOrcaCli(buildGetSettingsStateArgs(frame))).stdout
    ).result.snapshot.treeText
    // Re-select per snapshot: element indexes are reassigned after re-renders.
    const fieldLine = selectSettingsSearchBoxLine(treeText)
    const fieldIndex = fieldLine ? parseElementLineIndex(fieldLine) : -1
    const resultLines = fieldLine
      ? findSettingsSearchEchoLines(treeText, SEARCH_PROBE, fieldIndex)
      : []
    lastDiagnostics = `searchBox=${fieldLine ? 'unique' : 'absent-or-ambiguous'}, probe lines:\n${treeText
      .split('\n')
      .filter((line) => line.includes(SEARCH_PROBE))
      .join('\n')}`

    if (fieldLine && fieldLine.includes(SEARCH_PROBE) && resultLines.length > 0) {
      return
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Settings search did not echo "${SEARCH_PROBE}" in ${SEARCH_POLL_DEADLINE_MS}ms.\n${lastDiagnostics}`
      )
    }

    const { promise: ticked, resolve: onTicked } = Promise.withResolvers<void>()
    setTimeout(onTicked, SEARCH_POLL_INTERVAL_MS)
    await ticked
  }
}
