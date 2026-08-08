import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'

/**
 * #12871 capture, not a gate. The bare-page recording of the same input source and the same
 * preedit delivers the chord's keyup at every listener position, still composing; in-app the
 * recovery never fires. This spec records where the release goes instead — at four positions,
 * with focus ownership and the live target sampled on every row, so "never dispatched" can be
 * told apart from "dispatched somewhere else".
 */

const TWO_SET_KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'
const KOTOERI_ROMAJI_ID = 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese'
const KOTOERI_ROMAJI_PARENT_ID = 'com.apple.inputmethod.Kotoeri.RomajiTyping'
const ABC_ID = 'com.apple.keylayout.ABC'
const SELECT_INPUT_SOURCE = path.resolve(__dirname, 'select-input-source.swift')
const KEY = { left: 123, backspace: 51 } as const

function selectInputSource(id: string): void {
  execFileSync('swift', [SELECT_INPUT_SOURCE, id])
}

function enableInputSource(id: string): void {
  execFileSync('swift', ['-'], {
    input: `
import Carbon
let properties = [kTISPropertyInputSourceID: ${JSON.stringify(id)} as CFString] as CFDictionary
let sources = TISCreateInputSourceList(properties, true).takeRetainedValue() as! [TISInputSource]
guard !sources.isEmpty else { exit(3) }
for candidate in sources { TISEnableInputSource(candidate) }
exit(0)
`
  })
}

function focusApp(processId: number): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    'delay 0.3'
  ])
}

function bounceFocus(processId: number): void {
  execFileSync('osascript', ['-e', 'tell application "Finder" to activate', '-e', 'delay 0.4'])
  focusApp(processId)
}

function typeKeyCodes(processId: number, keyCodes: readonly number[]): void {
  focusApp(processId)
  execFileSync('osascript', [
    '-e',
    'tell application "System Events"',
    '-e',
    `repeat with currentKeyCode in {${keyCodes.join(', ')}}`,
    '-e',
    'key code (currentKeyCode as integer)',
    '-e',
    'delay 0.12',
    '-e',
    'end repeat',
    '-e',
    'end tell'
  ])
}

function pressChord(processId: number, keyCode: number, modifier?: 'command' | 'option'): void {
  focusApp(processId)
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to key code ${keyCode}${modifier ? ` using ${modifier} down` : ''}`
  ])
}

function readActiveComposition(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    const composition = textarea?.parentElement?.querySelector<HTMLElement>(
      '.composition-view.active'
    )
    return composition?.textContent?.replaceAll('\u200e', '') ?? null
  })
}

/** Four listener positions plus focus ownership, so a missing release can be located. */
async function installChordProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ProbeWindow = Window & { __chordKeyupProbe?: { rows: unknown[]; dispose: () => void } }
    const probeWindow = window as ProbeWindow
    probeWindow.__chordKeyupProbe?.dispose()

    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    if (!textarea) {
      throw new Error('no focused xterm helper textarea')
    }
    const rows: unknown[] = []
    const describe = (node: EventTarget | null): string | null =>
      node instanceof Element ? `${node.tagName}.${node.className}` : null

    const pushKey = (at: string, event: KeyboardEvent): void => {
      rows.push({
        at,
        t: event.type,
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        isComposing: event.isComposing,
        meta: event.metaKey,
        alt: event.altKey,
        defaultPrevented: event.defaultPrevented,
        // Why these three: a release that never reaches the renderer and one that reaches a
        // different target look identical from a single listener.
        hasFocus: document.hasFocus(),
        activeElement: describe(document.activeElement),
        target: describe(event.target),
        textareaConnected: textarea.isConnected,
        ts: Math.round(performance.now())
      })
    }

    const positions: [string, EventTarget, boolean][] = [
      ['window-capture', window, true],
      ['document-capture', document, true],
      ['textarea-capture', textarea, true],
      ['window-bubble', window, false]
    ]
    const keyListeners: (() => void)[] = []
    for (const [name, target, capture] of positions) {
      for (const type of ['keydown', 'keyup']) {
        const listener = (event: Event): void => pushKey(name, event as KeyboardEvent)
        target.addEventListener(type, listener, capture)
        keyListeners.push(() => target.removeEventListener(type, listener, capture))
      }
    }

    // Focus loss between press and release would route the keyup out of this window entirely.
    const focusListeners: (() => void)[] = []
    for (const [name, target, type] of [
      ['window', window, 'blur'],
      ['window', window, 'focus'],
      ['textarea', textarea, 'blur'],
      ['textarea', textarea, 'focus'],
      ['document', document, 'visibilitychange']
    ] as [string, EventTarget, string][]) {
      const listener = (): void => {
        rows.push({
          at: name,
          t: type,
          hasFocus: document.hasFocus(),
          activeElement: describe(document.activeElement),
          ts: Math.round(performance.now())
        })
      }
      target.addEventListener(type, listener, true)
      focusListeners.push(() => target.removeEventListener(type, listener, true))
    }

    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) {
      const listener = (event: Event): void => {
        rows.push({
          at: 'textarea',
          t: event.type,
          data: (event as CompositionEvent).data ?? null,
          value: textarea.value,
          ts: Math.round(performance.now())
        })
      }
      textarea.addEventListener(type, listener, true)
      focusListeners.push(() => textarea.removeEventListener(type, listener, true))
    }

    probeWindow.__chordKeyupProbe = {
      rows,
      dispose: () => {
        for (const off of [...keyListeners, ...focusListeners]) {
          off()
        }
      }
    }
  })
}

function readChordProbe(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const probe = (window as Window & { __chordKeyupProbe?: { rows: unknown[] } }).__chordKeyupProbe
    if (!probe) {
      throw new Error('chord probe was never installed')
    }
    return [...probe.rows]
  })
}

test.describe('Kotoeri chord keyup probe @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_KOREAN !== '1',
    'Requires macOS with native IME access and Accessibility permission'
  )

  test.afterEach(() => {
    selectInputSource(TWO_SET_KOREAN_ID)
  })

  test('records where the Cmd+Left release goes while さ is composing', async ({
    electronApp,
    orcaPage
  }) => {
    const processId = electronApp.process().pid
    if (processId === undefined) {
      throw new Error('Electron process id unavailable')
    }
    await waitForActiveWorktree(orcaPage)
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await waitForActivePanePtyId(orcaPage)
    await focusActiveTerminalInput(orcaPage)

    enableInputSource(KOTOERI_ROMAJI_PARENT_ID)
    enableInputSource(KOTOERI_ROMAJI_ID)
    selectInputSource(KOTOERI_ROMAJI_ID)
    bounceFocus(processId)
    await focusActiveTerminalInput(orcaPage)

    typeKeyCodes(processId, [1, 0]) // s, a -> さ
    try {
      await expect
        .poll(() => readActiveComposition(orcaPage), { timeout: 6_000 })
        .toMatch(/[ぁ-ん]/)
    } catch {
      bounceFocus(processId)
      await focusActiveTerminalInput(orcaPage)
      typeKeyCodes(processId, [1, 0])
      await expect
        .poll(() => readActiveComposition(orcaPage), { timeout: 10_000 })
        .toMatch(/[ぁ-ん]/)
    }

    await installChordProbe(orcaPage)
    pressChord(processId, KEY.left, 'command')
    await orcaPage.waitForTimeout(1_500)
    // A bare arrow afterwards shows whether the window still routes keys here at all.
    pressChord(processId, KEY.left)
    await orcaPage.waitForTimeout(800)

    const rows = await readChordProbe(orcaPage)
    const body = `${JSON.stringify(rows, null, 1)}\n`
    const dir = path.join(process.cwd(), 'test-results', 'terminal-ime-evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'kotoeri-chord-keyup-probe.json'), body)
    console.log('CHORD_PROBE_ROWS', body)

    typeKeyCodes(processId, [KEY.backspace, KEY.backspace])
    expect(rows.length).toBeGreaterThan(0)
  })

  test('ABC control: whether a Cmd release arrives at all with no IME present', async ({
    electronApp,
    orcaPage
  }) => {
    const processId = electronApp.process().pid
    if (processId === undefined) {
      throw new Error('Electron process id unavailable')
    }
    await waitForActiveWorktree(orcaPage)
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await waitForActivePanePtyId(orcaPage)
    await focusActiveTerminalInput(orcaPage)

    selectInputSource(ABC_ID)
    bounceFocus(processId)
    await focusActiveTerminalInput(orcaPage)

    await installChordProbe(orcaPage)
    pressChord(processId, KEY.left, 'command')
    await orcaPage.waitForTimeout(800)
    pressChord(processId, KEY.left, 'option')
    await orcaPage.waitForTimeout(800)
    pressChord(processId, KEY.left)
    await orcaPage.waitForTimeout(800)

    const rows = await readChordProbe(orcaPage)
    const body = `${JSON.stringify(rows, null, 1)}\n`
    const dir = path.join(process.cwd(), 'test-results', 'terminal-ime-evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'abc-chord-keyup-probe.json'), body)
    expect(rows.length).toBeGreaterThan(0)
  })

  test('Kotoeri + Option+Left: does the release-driven recovery reach the pty', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    const processId = electronApp.process().pid
    if (processId === undefined) {
      throw new Error('Electron process id unavailable')
    }
    await waitForActiveWorktree(orcaPage)
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await focusActiveTerminalInput(orcaPage)

    enableInputSource(KOTOERI_ROMAJI_PARENT_ID)
    enableInputSource(KOTOERI_ROMAJI_ID)
    selectInputSource(KOTOERI_ROMAJI_ID)
    bounceFocus(processId)
    await focusActiveTerminalInput(orcaPage)

    const reader = createTerminalImeByteReader(testRepoPath, 1)
    await startTerminalImeByteReader(orcaPage, ptyId, reader)
    await focusActiveTerminalInput(orcaPage)
    try {
      typeKeyCodes(processId, [1, 0])
      await expect
        .poll(() => readActiveComposition(orcaPage), { timeout: 10_000 })
        .toMatch(/[\u3041-\u3093]/)

      await installChordProbe(orcaPage)
      pressChord(processId, KEY.left, 'option')
      await orcaPage.waitForTimeout(1_200)

      const rows = await readChordProbe(orcaPage)
      mkdirSync(path.join(process.cwd(), 'test-results', 'terminal-ime-evidence'), {
        recursive: true
      })
      writeFileSync(
        path.join(
          process.cwd(),
          'test-results',
          'terminal-ime-evidence',
          'kotoeri-option-probe.json'
        ),
        `${JSON.stringify(rows, null, 1)}\n`
      )

      // A live preedit eats the first Return; the second one flushes the line (same as the
      // contributor's flushLineToReader).
      pressChord(processId, 36)
      let bytes = await waitForTerminalImeBytes(orcaPage, reader, 5_000).catch(() => [])
      if (bytes.length === 0) {
        pressChord(processId, 36)
        bytes = await waitForTerminalImeBytes(orcaPage, reader, 10_000).catch(() => [])
      }
      console.log('KOTOERI_OPTION_PTY', JSON.stringify(bytes))
      writeFileSync(
        path.join(
          process.cwd(),
          'test-results',
          'terminal-ime-evidence',
          'kotoeri-option-pty.json'
        ),
        `${JSON.stringify(bytes)}\n`
      )
      expect(rows.length).toBeGreaterThan(0)
    } finally {
      removeTerminalImeByteReader(reader)
      selectInputSource(TWO_SET_KOREAN_ID)
    }
  })
})
