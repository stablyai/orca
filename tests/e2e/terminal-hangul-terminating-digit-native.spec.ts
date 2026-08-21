/**
 * Drives a real Hangul input method through a real compositor and asserts the bytes that reach
 * the pty. Written to reproduce #15299, where a digit typed straight after a Hangul syllable was
 * dropped under Wayland but not under X11.
 *
 * THIS DOES NOT RUN IN CI. It is gated on ORCA_E2E_NATIVE_IBUS_HANGUL=1 and needs a compositor
 * session that CI does not have, so it is a manual reproduction harness rather than coverage.
 * That is stated plainly because this repo already carries native IME specs that are skipped
 * everywhere and were mistaken for coverage they never provided.
 *
 * To run it, on a machine with gnome-shell and ibus-hangul:
 *
 *   Xvfb :65 -extension GLX &
 *   DISPLAY=:65 gnome-shell --nested --wayland     # nested, NOT --headless
 *   ORCA_E2E_NATIVE_IBUS_HANGUL=1 ORCA_E2E_IME_INJECTOR=nested npx playwright test \
 *     tests/e2e/terminal-hangul-terminating-digit-native.spec.ts
 *
 * Eight things that decide whether a run is real or a silent false negative, each of which cost a
 * failed attempt:
 *
 *  - Nested, not headless. A headless mutter never answers RemoteDesktop.CreateSession, so there
 *    is no way to inject input; nested makes the whole compositor an X window that xdotool can
 *    type into. ydotool does not help either - headless has no evdev seat.
 *  - Pick an unused display. Attaching to a stale Xvfb silently hands the run someone else's
 *    session, and a stale ibus-daemon wins the XIM selection over the new one.
 *  - The session script must not exit: ibus-daemon dies with its parent.
 *  - Under Playwright the window can stay hidden in a Wayland session, so the compositor has
 *    nothing to focus and zero DOM events arrive. The spec forces show()/focus().
 *  - Send Escape before the byte reader starts, or GNOME's overview keeps focus and the Escape
 *    bytes corrupt the first line.
 *  - Check the session's ibus-daemon is not running --panel=disable before trusting anything that
 *    depends on seeing a candidate window. No panel means no lookup table is ever drawn, so a
 *    candidate-selection run measures nothing and reads as "the IME ignored the key".
 *  - Launch the browser with --password-store=basic --use-mock-keychain. A gnome-keyring unlock
 *    dialog or a Chrome update bubble grabs the keyboard, xdotool keys never reach the page, and
 *    the empty event log looks exactly like a broken IME.
 *  - Click the input to focus it. windowactivate alone does not give web contents real focus.
 *
 * The keys and expected text are environment-tunable, so other IME issues can reuse this
 * unchanged rather than writing another one.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'

const NATIVE_COMMAND_TIMEOUT_MS = 10_000
const REPETITIONS = Number(process.env.ORCA_E2E_DIGIT_REPETITIONS ?? 3)
const INJECTOR = process.env.ORCA_E2E_IME_INJECTOR ?? 'xdotool'
const WAYLAND_INJECT = process.env.ORCA_E2E_WAYLAND_INJECT ?? '/tmp/ime15299/wayland-inject.py'
// The nested compositor is one X11 window; keys land on it and mutter routes
// them to the focused Wayland client through the IME.
const NESTED_FOCUS_CMD = process.env.ORCA_E2E_NESTED_FOCUS_CMD ?? '/tmp/ime15299/focus-nested.sh'
// Dubeolsik: d=ㅇ, k=ㅏ, so `d k` composes 아 and the digit terminates it.
const KEY_TOKENS = (process.env.ORCA_E2E_DIGIT_KEYS ?? 'd k 1 Return').split(' ').filter(Boolean)
const EXPECTED_LINE = process.env.ORCA_E2E_DIGIT_EXPECTED ?? '아1'

test.use({
  orcaAppExtraEnv: {
    GTK_IM_MODULE: 'ibus',
    IBUS_ENABLE_SYNC_MODE: '1',
    QT_IM_MODULE: 'ibus',
    XMODIFIERS: '@im=ibus',
    ...(process.env.ORCA_E2E_EXTRA_APP_ENV
      ? (JSON.parse(process.env.ORCA_E2E_EXTRA_APP_ENV) as Record<string, string>)
      : {})
  },
  orcaAppExtraArgs: (process.env.ORCA_E2E_EXTRA_APP_ARGS ?? '').split(' ').filter(Boolean)
})

function injectKeys(tokens: string[]): void {
  if (INJECTOR === 'wayland') {
    execFileSync('python3', [WAYLAND_INJECT, ...tokens], {
      stdio: 'pipe',
      timeout: NATIVE_COMMAND_TIMEOUT_MS
    })
    return
  }
  for (const token of tokens) {
    execFileSync('xdotool', ['key', '--clearmodifiers', token], {
      stdio: 'pipe',
      timeout: NATIVE_COMMAND_TIMEOUT_MS
    })
  }
}

/** GNOME Shell parks keyboard focus in the overview until a window is up, so
 *  Escape has to run before the byte reader starts or those Escapes land in it. */
function leaveNestedOverview(): void {
  execFileSync(NESTED_FOCUS_CMD, [], { stdio: 'pipe', timeout: NATIVE_COMMAND_TIMEOUT_MS })
  for (let index = 0; index < 2; index += 1) {
    execFileSync('xdotool', ['key', 'Escape'], {
      stdio: 'pipe',
      timeout: NATIVE_COMMAND_TIMEOUT_MS
    })
  }
}

function captureNestedScreen(name: string): void {
  const dir = path.join(process.cwd(), 'test-results', 'terminal-ime-evidence')
  mkdirSync(dir, { recursive: true })
  execFileSync('import', ['-window', 'root', path.join(dir, `${name}.png`)], {
    stdio: 'pipe',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  })
}

async function focusNativeTerminalWindow(page: Page): Promise<void> {
  await focusActiveTerminalInput(page)
  const title = `ORCA_NATIVE_IBUS_${randomUUID()}`
  await page.evaluate((nextTitle) => {
    document.title = nextTitle
  }, title)
  await expect.poll(() => page.title(), { timeout: 5_000 }).toBe(title)
  if (INJECTOR === 'nested') {
    execFileSync(NESTED_FOCUS_CMD, [], {
      stdio: 'pipe',
      timeout: NATIVE_COMMAND_TIMEOUT_MS
    })
  } else if (INJECTOR !== 'wayland') {
    execFileSync('xdotool', ['search', '--onlyvisible', '--name', title, 'windowfocus', '--sync'], {
      stdio: 'pipe',
      timeout: NATIVE_COMMAND_TIMEOUT_MS
    })
  }
  execFileSync('ibus', ['engine', 'hangul'], {
    stdio: 'pipe',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  })
  const engine = execFileSync('ibus', ['engine'], {
    encoding: 'utf8',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  }).trim()
  expect(engine).toBe('hangul')
}

async function writeEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  extra: Record<string, unknown>
): Promise<void> {
  const trace = await readTerminalImeBoundaryTrace(page)
  const payload = { ...extra, injector: INJECTOR, keyTokens: KEY_TOKENS, trace }
  const body = `${JSON.stringify(payload, null, 2)}\n`
  await testInfo.attach(`${name}.json`, { body, contentType: 'application/json' })
  const dir = path.join(process.cwd(), 'test-results', 'terminal-ime-evidence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${name}.json`), body)
}

test.describe('Hangul terminating digit @headful', () => {
  test.skip(process.env.ORCA_E2E_NATIVE_IBUS_HANGUL !== '1', 'native ibus harness only')

  test('a digit typed right after a Hangul syllable reaches the pty', async ({
    electronApp,
    orcaPage: page,
    testRepoPath
  }, testInfo) => {
    const launchDiagnostics = await electronApp.evaluate(({ app: electron, BrowserWindow }) => ({
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
      display: process.env.DISPLAY ?? null,
      xdgRuntimeDir: process.env.XDG_RUNTIME_DIR ?? null,
      ozonePlatform: electron.commandLine.getSwitchValue('ozone-platform'),
      disableGpu: electron.commandLine.hasSwitch('disable-gpu'),
      windows: BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        minimized: window.isMinimized(),
        bounds: window.getBounds()
      }))
    }))
    console.log(`[digit-diag] ${JSON.stringify(launchDiagnostics)}`)
    if (INJECTOR === 'nested') {
      // Under Wayland the app's ready-to-show never fires here, so the window
      // stays hidden and the compositor has nothing to give keyboard focus to.
      await electronApp.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.show()
          window.focus()
        }
      })
      await page.waitForTimeout(2_000)
    }
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)

    const ptyId = await waitForActivePanePtyId(page)
    const reader = createTerminalImeByteReader(testRepoPath, REPETITIONS)
    let receivedBytes: string[] = []
    const expectedHex = Buffer.from(`${EXPECTED_LINE}\n`).toString('hex')
    try {
      if (INJECTOR === 'nested') {
        leaveNestedOverview()
        await page.waitForTimeout(1_500)
        captureNestedScreen('nested-before-reader')
      }
      await startTerminalImeByteReader(page, ptyId, reader)
      await focusNativeTerminalWindow(page)
      if (INJECTOR === 'nested') {
        captureNestedScreen('nested-before-typing')
      }
      await installTerminalImeBoundaryProbe(page)

      for (let index = 0; index < REPETITIONS; index += 1) {
        injectKeys(KEY_TOKENS)
        await page.waitForTimeout(500)
      }
      if (INJECTOR === 'nested') {
        captureNestedScreen('nested-after-typing')
      }

      receivedBytes = await waitForTerminalImeBytes(page, reader, 20_000)
    } finally {
      await writeEvidence(page, testInfo, 'hangul-terminating-digit', {
        expectedHex,
        expectedLine: EXPECTED_LINE,
        receivedBytes,
        decoded: receivedBytes.map((hex) => Buffer.from(hex, 'hex').toString('utf8'))
      }).catch(() => undefined)
      await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
      await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
      removeTerminalImeByteReader(reader)
    }
    expect(receivedBytes.map((hex) => Buffer.from(hex, 'hex').toString('utf8'))).toEqual(
      Array.from({ length: REPETITIONS }, () => `${EXPECTED_LINE}\n`)
    )
  })
})
