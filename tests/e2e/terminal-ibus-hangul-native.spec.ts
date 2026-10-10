import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import type { BrowserWindow, Event as ElectronEvent, Input as ElectronInput } from 'electron'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  attachTerminalImeBoundaryEvidence,
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace,
  type TerminalImeDomEvent
} from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import { appendImeEngagementReceipt } from './terminal-ime-engagement-receipt'
import { presentNativeIbusWindow } from './terminal-native-ibus-window'

const DEFAULT_REPETITIONS = 30
const MAX_REPETITIONS = 30
const DEFAULT_KEY_DELAY_MS = 1
const MAX_KEY_DELAY_MS = 100
const NATIVE_COMMAND_TIMEOUT_MS = 10_000

test.use({
  orcaAppExtraEnv: {
    GTK_IM_MODULE: 'ibus',
    IBUS_ENABLE_SYNC_MODE: '1',
    QT_IM_MODULE: 'ibus',
    XMODIFIERS: '@im=ibus'
  }
})

function nativeRepetitions(): number {
  const parsed = Number(process.env.ORCA_E2E_NATIVE_IBUS_REPETITIONS ?? DEFAULT_REPETITIONS)
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_REPETITIONS)
    : DEFAULT_REPETITIONS
}

function nativeKeyDelayMs(): number {
  const parsed = Number(process.env.ORCA_E2E_NATIVE_IBUS_KEY_DELAY_MS ?? DEFAULT_KEY_DELAY_MS)
  return Number.isInteger(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_KEY_DELAY_MS)
    : DEFAULT_KEY_DELAY_MS
}

function runXdotool(...args: string[]): void {
  execFileSync('xdotool', args, { stdio: 'pipe', timeout: NATIVE_COMMAND_TIMEOUT_MS })
}

async function focusNativeTerminalWindow(page: Page): Promise<string> {
  await focusActiveTerminalInput(page)
  const title = `ORCA_NATIVE_IBUS_${randomUUID()}`
  await page.evaluate((nextTitle) => {
    document.title = nextTitle
  }, title)
  await expect.poll(() => page.title(), { timeout: 5_000 }).toBe(title)

  runXdotool('search', '--onlyvisible', '--name', title, 'windowfocus', '--sync')
  execFileSync('ibus', ['engine', 'hangul'], {
    stdio: 'pipe',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  })
  const engine = execFileSync('ibus', ['engine'], {
    encoding: 'utf8',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  }).trim()
  expect(engine).toBe('hangul')
  return title
}

function typeExactByteSequence(repetitions: number): void {
  const delay = String(nativeKeyDelayMs())
  for (let index = 0; index < repetitions; index += 1) {
    runXdotool('type', '--delay', delay, '--clearmodifiers', 'gks')
    runXdotool('key', 'Hangul')
    runXdotool('type', '--delay', delay, 'abc')
    runXdotool('key', 'Hangul')
    runXdotool('type', '--delay', delay, 'rmf')
    runXdotool('key', 'Return')
  }
}

function typeSentenceSequence(repetitions: number): void {
  const delay = String(nativeKeyDelayMs())
  for (let index = 0; index < repetitions; index += 1) {
    runXdotool(
      'type',
      '--delay',
      delay,
      '--clearmodifiers',
      'xptmxmfmf gkrh dlTsmsep duwjsgl rmfjsp'
    )
    runXdotool('key', 'Return')
  }
}

async function runNativeIbusScenario(
  electronApp: ElectronApplication,
  page: Page,
  testInfo: TestInfo,
  testRepoPath: string,
  expectedText: string,
  driveInput: (repetitions: number) => void
): Promise<void> {
  await presentNativeIbusWindow(electronApp, page)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)

  const repetitions = nativeRepetitions()
  const ptyId = await waitForActivePanePtyId(page)
  const reader = createTerminalImeByteReader(testRepoPath, repetitions)
  let completed = false
  let receivedBytes: string[] = []
  try {
    await startTerminalImeByteReader(page, ptyId, reader)
    await focusNativeTerminalWindow(page)
    await installTerminalImeBoundaryProbe(page)
    driveInput(repetitions)

    receivedBytes = await waitForTerminalImeBytes(page, reader, 30_000)
    const trace = await readTerminalImeBoundaryTrace(page)
    expect(trace.dom.some((event) => event.type === 'compositionstart')).toBe(true)
    expect(
      trace.dom.some(
        (event) =>
          (event.type === 'compositionupdate' ||
            (event.type === 'input' && event.inputType === 'insertText')) &&
          /[\uac00-\ud7af]/.test(event.data ?? '')
      )
    ).toBe(true)

    const expectedBytes = Buffer.from(`${expectedText}\n`).toString('hex')
    expect(receivedBytes).toEqual(Array.from({ length: repetitions }, () => expectedBytes))

    expect(trace.onData.join('')).toBe(`${expectedText}\r`.repeat(repetitions))
    // Why after the assertions: the receipt is the runner's proof this test ran against a live
    // engine, so it must not exist for a run that reached here with the bytes wrong.
    appendImeEngagementReceipt(testInfo.title, trace)
    completed = true
  } finally {
    await attachTerminalImeBoundaryEvidence(page, testInfo, 'native-ibus-boundaries', {
      display: process.env.DISPLAY,
      expectedText,
      keyDelayMs: nativeKeyDelayMs(),
      receivedBytes,
      repetitions
    }).catch(() => undefined)
    await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
    if (!completed) {
      await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
    }
    removeTerminalImeByteReader(reader)
  }
}

test.describe('Native IBus Hangul terminal input @headful', () => {
  test.skip(
    process.env.ORCA_E2E_NATIVE_IBUS_HANGUL !== '1',
    'Run through config/scripts/run-terminal-ibus-hangul-e2e.mjs'
  )

  test('forwards the issue exact-byte sequence without loss or duplication', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeIbusScenario(
      electronApp,
      orcaPage,
      testInfo,
      testRepoPath,
      '한abc글',
      typeExactByteSequence
    )
  })

  test('forwards the issue sentence stress sequence without leaked ASCII', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeIbusScenario(
      electronApp,
      orcaPage,
      testInfo,
      testRepoPath,
      '테스트를 하고 있는데 여전히 그러네',
      typeSentenceSequence
    )
  })
})

test.describe('Native IBus Hangul workspace notes @headful', () => {
  test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })
  test.skip(
    process.env.ORCA_E2E_NATIVE_IBUS_HANGUL !== '1',
    'Run through the isolated native IBus harness'
  )

  test('confirms native Hangul notes before a deliberate Enter saves', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    expect(process.platform).toBe('linux')
    expect(process.env.GITHUB_ACTIONS).toBe('true')
    expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted')
    expect(process.env.DISPLAY).toMatch(/^:\d+(?:\.\d+)?$/)
    const ownedWindow = await electronApp.browserWindow(orcaPage)
    await presentNativeIbusWindow(electronApp, orcaPage)
    const windowId = await ownedWindow.evaluate((window: BrowserWindow) =>
      window.getNativeWindowHandle().readUInt32LE(0).toString()
    )
    execFileSync('ibus', ['engine', 'hangul'], { timeout: NATIVE_COMMAND_TIMEOUT_MS })
    expect(
      execFileSync('ibus', ['engine'], {
        encoding: 'utf8',
        timeout: NATIVE_COMMAND_TIMEOUT_MS
      }).trim()
    ).toBe('hangul')

    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const worktree =
        state &&
        Object.values(state.worktreesByRepo)
          .flat()
          .find((row) => row.id === state.activeWorktreeId)
      if (!state || !worktree) {
        throw new Error('Missing owned workspace')
      }
      state.openModal('edit-meta', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        currentDisplayName: worktree.displayName,
        currentComment: '',
        focus: 'comment'
      })
    })
    const input = orcaPage.getByPlaceholder('Notes about this worktree...')
    await expect(input).toBeVisible()
    await input.evaluate(async (element) => {
      const animations = element.closest('[role=dialog]')?.getAnimations({ subtree: true }) ?? []
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
    })
    const nativeProbe = await ownedWindow.evaluateHandle((window: BrowserWindow) => {
      const inputs: ElectronInput[] = []
      const record = (_event: ElectronEvent, input: ElectronInput): void => {
        inputs.push({ ...input })
      }
      window.webContents.on('before-input-event', record)
      return {
        window,
        inputs,
        dispose: () => window.webContents.removeListener('before-input-event', record)
      }
    })
    const events = await input.evaluateHandle((element) => {
      if (!(element instanceof HTMLTextAreaElement)) {
        throw new Error('Missing Notes textarea')
      }
      const dom: TerminalImeDomEvent[] = []
      const capture: {
        type: string
        scope: string
        key: string | null
        code: string | null
        keyCode: number | null
        isComposing: boolean | null
        isTrusted: boolean
        targetIsNotes: boolean
        activeIsNotes: boolean
        documentFocused: boolean
        target: string
        path: string[]
      }[] = []
      const label = (target: EventTarget | null): string =>
        target instanceof Element
          ? `${target.tagName}#${target.id}[${target.getAttribute('placeholder') ?? ''}]`
          : target === window
            ? 'window'
            : target === document
              ? 'document'
              : 'other'
      const recordDom = (event: Event): void => {
        const keyboard = event instanceof KeyboardEvent ? event : null
        const inputEvent = event instanceof InputEvent ? event : null
        const composition = event instanceof CompositionEvent ? event : null
        dom.push({
          type: event.type,
          data: inputEvent?.data ?? composition?.data ?? null,
          inputType: inputEvent?.inputType ?? null,
          key: keyboard?.key ?? null,
          code: keyboard?.code ?? null,
          keyCode: keyboard?.keyCode ?? null,
          isComposing: keyboard?.isComposing ?? inputEvent?.isComposing ?? null,
          selectionEnd: element.selectionEnd,
          selectionStart: element.selectionStart,
          value: element.value
        })
      }
      const recordCapture = (event: Event): void => {
        const keyboard = event instanceof KeyboardEvent ? event : null
        capture.push({
          type: event.type,
          scope: label(event.currentTarget),
          key: keyboard?.key ?? null,
          code: keyboard?.code ?? null,
          keyCode: keyboard?.keyCode ?? null,
          isComposing: keyboard?.isComposing ?? null,
          isTrusted: event.isTrusted,
          targetIsNotes: event.target === element,
          activeIsNotes: document.activeElement === element,
          documentFocused: document.hasFocus(),
          target: label(event.target),
          path: event.composedPath().map(label)
        })
      }
      const domTypes = [
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'input',
        'keydown',
        'keyup'
      ]
      const captureTypes = ['keydown', 'keyup', 'focus', 'blur']
      for (const type of domTypes) {
        element.addEventListener(type, recordDom, true)
      }
      for (const target of [window, document]) {
        for (const type of captureTypes) {
          target.addEventListener(type, recordCapture, true)
        }
      }
      return {
        dom,
        capture,
        focus: () => ({
          documentFocused: document.hasFocus(),
          activeIsNotes: document.activeElement === element,
          activeElement: label(document.activeElement),
          connected: element.isConnected,
          value: element.value
        }),
        dispose: () => {
          for (const type of domTypes) {
            element.removeEventListener(type, recordDom, true)
          }
          for (const target of [window, document]) {
            for (const type of captureTypes) {
              target.removeEventListener(type, recordCapture, true)
            }
          }
        }
      }
    })
    const readSavedComment = () =>
      orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        return (
          state &&
          Object.values(state.worktreesByRepo)
            .flat()
            .find((row) => row.id === state.activeWorktreeId)?.comment
        )
      })
    const focusSnapshots: unknown[] = []
    const readFocus = async (phase: string) => {
      const renderer = await events.evaluate((probe) => probe.focus())
      const main = await nativeProbe.evaluate(({ window }) => ({
        windowFocused: window.isFocused(),
        windowVisible: window.isVisible(),
        webContentsFocused: window.webContents.isFocused(),
        nativeWindowId: window.getNativeWindowHandle().readUInt32LE(0).toString()
      }))
      const xFocus = execFileSync('xdotool', ['getwindowfocus'], {
        encoding: 'utf8',
        timeout: NATIVE_COMMAND_TIMEOUT_MS
      }).trim()
      const snapshot = { phase, renderer, main, xFocus, windowId }
      focusSnapshots.push(snapshot)
      expect(main.nativeWindowId).toBe(windowId)
      expect(xFocus).toBe(windowId)
      expect(main.windowFocused).toBe(true)
      expect(main.windowVisible).toBe(true)
      expect(main.webContentsFocused).toBe(true)
      expect(renderer.documentFocused).toBe(true)
      expect(renderer.activeIsNotes).toBe(true)
      return snapshot
    }
    let completed = false
    try {
      runXdotool('windowfocus', '--sync', windowId)
      await nativeProbe.evaluate(({ window }) => window.webContents.focus())
      const geometry = await orcaPage.evaluate(() => ({
        ratio: window.devicePixelRatio,
        width: window.innerWidth,
        height: window.innerHeight
      }))
      const content = await ownedWindow.evaluate((window: BrowserWindow) =>
        window.getContentBounds()
      )
      expect(geometry.ratio).toBe(1)
      expect(content.width).toBe(geometry.width)
      expect(content.height).toBe(geometry.height)
      const box = await input.boundingBox()
      expect(box).not.toBeNull()
      if (!box) {
        throw new Error('Missing native Notes input bounds')
      }
      runXdotool(
        'mousemove',
        '--window',
        windowId,
        String(Math.round(box.x + box.width / 2)),
        String(Math.round(box.y + box.height / 2)),
        'click',
        '1'
      )
      await expect
        .poll(() =>
          events.evaluate((probe) => {
            const focus = probe.focus()
            return focus.documentFocused && focus.activeIsNotes
          })
        )
        .toBe(true)
      await readFocus('before-delivery-witness')
      runXdotool('key', '--clearmodifiers', 'Shift_L')
      await expect
        .poll(() =>
          events.evaluate(({ capture }) =>
            ['keydown', 'keyup'].every((type) =>
              capture.some(
                (event) =>
                  event.type === type &&
                  event.key === 'Shift' &&
                  event.scope === 'window' &&
                  event.isTrusted &&
                  event.targetIsNotes &&
                  event.activeIsNotes &&
                  event.documentFocused
              )
            )
          )
        )
        .toBe(true)
      await readFocus('before-composition')
      const blursBeforeComposition = await events.evaluate(
        ({ capture }) => capture.filter((event) => event.type === 'blur').length
      )
      runXdotool('type', '--delay', '10', '--clearmodifiers', 'gksrmf')
      await expect(input).toHaveValue('한글')
      await expect
        .poll(() =>
          events.evaluate(
            ({ dom: trace }) =>
              trace.filter((event) => event.type === 'compositionstart').length >
              trace.filter((event) => event.type === 'compositionend').length
          )
        )
        .toBe(true)
      const compositionEndsBeforeReturn = await events.evaluate(
        ({ dom: trace }) => trace.filter((event) => event.type === 'compositionend').length
      )
      await readFocus('before-confirm-return')
      runXdotool('key', 'Return')
      await expect
        .poll(() =>
          events.evaluate(
            ({ dom: trace }) => trace.filter((event) => event.type === 'compositionend').length
          )
        )
        .toBeGreaterThan(compositionEndsBeforeReturn)
      await orcaPage.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      await expect(input).toBeVisible()
      await expect(input).toHaveValue('한글')
      expect(await readSavedComment()).not.toBe('한글')
      await readFocus('before-save-return')
      expect(
        await events.evaluate(
          ({ capture }) => capture.filter((event) => event.type === 'blur').length
        )
      ).toBe(blursBeforeComposition)
      const capturesBeforeSave = await events.evaluate(({ capture }) => capture.length)
      runXdotool('key', 'Return')
      await expect
        .poll(() =>
          events.evaluate(
            ({ capture }, start) =>
              capture
                .slice(start)
                .some(
                  (event) =>
                    event.type === 'keydown' &&
                    event.key === 'Enter' &&
                    event.keyCode === 13 &&
                    event.isComposing === false &&
                    event.scope === 'window' &&
                    event.isTrusted &&
                    event.targetIsNotes &&
                    event.activeIsNotes &&
                    event.documentFocused
                ),
            capturesBeforeSave
          )
        )
        .toBe(true)
      await expect(input).toBeHidden()
      await expect.poll(readSavedComment).toBe('한글')
      const dom = await events.evaluate(({ dom }) => dom)
      expect(dom.some((event) => event.type === 'compositionstart')).toBe(true)
      expect(dom.some((event) => /[\uac00-\ud7af]/.test(event.data ?? ''))).toBe(true)
      appendImeEngagementReceipt(testInfo.title, { dom, onData: [] })
      completed = true
      await orcaPage.screenshot({
        path: testInfo.outputPath('native-deliberate-return-saves-notes.png')
      })
    } finally {
      const readDiagnostic = async <T>(read: () => Promise<T>): Promise<T | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            read().catch(() => null),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 1_000)
            })
          ])
        } catch {
          return null
        } finally {
          if (timer) {
            clearTimeout(timer)
          }
        }
      }
      const trace = await readDiagnostic(() =>
        events.evaluate(({ dom, capture, focus }) => ({ dom, capture, focus: focus() }))
      )
      const native = await readDiagnostic(() =>
        nativeProbe.evaluate(({ inputs, window }) => ({
          inputs,
          windowFocused: window.isFocused(),
          windowVisible: window.isVisible(),
          webContentsFocused: window.webContents.isFocused()
        }))
      )
      const notes = await readDiagnostic(() =>
        orcaPage.evaluate(() => {
          const element = document.querySelector(
            'textarea[placeholder="Notes about this worktree..."]'
          )
          const state = window.__store?.getState()
          return {
            notesPresent: element instanceof HTMLTextAreaElement,
            notesValue: element instanceof HTMLTextAreaElement ? element.value : null,
            savedComment:
              state &&
              Object.values(state.worktreesByRepo)
                .flat()
                .find((row) => row.id === state.activeWorktreeId)?.comment
          }
        })
      )
      let evidenceAttached = false
      try {
        const evidencePath = testInfo.outputPath('native-notes-dom-trace.json')
        writeFileSync(
          evidencePath,
          `${JSON.stringify({
            nativeOperatingSystemIme: true,
            engine: 'ibus-hangul',
            display: process.env.DISPLAY,
            completed,
            notes,
            focusSnapshots,
            native,
            onData: [],
            ...trace
          })}\n`
        )
        await testInfo.attach('native-notes-dom-trace', {
          path: evidencePath,
          contentType: 'application/json'
        })
        evidenceAttached = true
      } catch {
        // Failed-flow diagnostics must preserve the original assertion.
      }
      await readDiagnostic(() => events.evaluate((probe) => probe.dispose()))
      await readDiagnostic(() =>
        nativeProbe.evaluate((probe) => {
          probe.dispose()
        })
      )
      await events.dispose().catch(() => undefined)
      await nativeProbe.dispose().catch(() => undefined)
      await ownedWindow.dispose().catch(() => undefined)
      if (completed) {
        expect(trace).not.toBeNull()
        expect(native).not.toBeNull()
        expect(notes).not.toBeNull()
        expect(evidenceAttached).toBe(true)
      }
    }
  })
})
