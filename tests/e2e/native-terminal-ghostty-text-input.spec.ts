import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContentForPtyId, waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  nativeSurfaceField,
  nativeSurfaceIds,
  nativeTerminalDebug,
  type NativeTerminalDebugOp
} from './helpers/native-terminal-debug'

// NSEventModifierFlags and macOS virtual key codes (Carbon kVK_*).
const SHIFT = 1 << 17
const CONTROL = 1 << 18
const KEY_A = 0x00
const KEY_C = 0x08
const KEY_RETURN = 0x24
const KEY_SHIFT = 0x38

type Rect = { x: number; y: number; width: number; height: number }

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function rect(value: unknown): Rect {
  const fields = record(value)
  return {
    x: Number(fields.x),
    y: Number(fields.y),
    width: Number(fields.width),
    height: Number(fields.height)
  }
}

async function setupNativePane(
  page: Page,
  app: ElectronApplication
): Promise<{
  ptyId: string
  call: (op: NativeTerminalDebugOp, args?: unknown[]) => Promise<unknown>
  paneContent: () => Promise<string>
}> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  // The first pane stays an xterm pane: its PTY binds before the native setting is on.
  await waitForPtyShellEcho(page, await waitForActivePanePtyId(page), 30_000)
  await page.evaluate(async () => {
    await window.__store?.getState().updateSettings({ experimentalNativeTerminal: true })
  })
  await splitActiveTerminalPane(page, 'vertical')
  await waitForPaneCount(page, 2)
  const ptyId = await waitForActivePanePtyId(page)
  await waitForPtyShellEcho(page, ptyId, 30_000)
  let surfaceId = 0
  await expect
    .poll(async () => {
      surfaceId = (await nativeSurfaceIds(app)).at(-1) ?? 0
      return surfaceId
    })
    .toBeGreaterThan(0)
  await expect.poll(async () => nativeSurfaceField(app, surfaceId, 'hidden')).toBe(false)
  await nativeTerminalDebug(app, 'focus', [surfaceId])
  return {
    ptyId,
    call: (op, args = []) => nativeTerminalDebug(app, op, [surfaceId, ...args]),
    // Unwrapped, so a long line reads as one.
    paneContent: async () =>
      (await getTerminalContentForPtyId(page, ptyId, 8000)).replace(/\r?\n/g, '')
  }
}

test('native panes take dictation, IME, Services, paste and assistive input', async ({
  orcaPage,
  electronApp
}) => {
  const { ptyId, call, paneContent } = await setupNativePane(orcaPage, electronApp)
  await execInTerminal(orcaPage, ptyId, 'cat')

  // Emoji & Symbols is AppKit's Edit menu item: the native view leaves key equivalents to the
  // menu, and the palette commits into the first responder through insertText (below).
  const textInputMenu = await nativeTerminalDebug(electronApp, 'textInputMenu')
  expect(
    Array.isArray(textInputMenu) ? textInputMenu.map((item) => record(item).action) : []
  ).toContain('orderFrontCharacterPalette:')

  // IME: the preedit stays on the surface (never the PTY), the candidate window follows the
  // composition caret inside the view, and the committed text is typed input.
  expect(record(await call('markedText', ['にほんご', 4])).hasMarkedText).toBe(true)
  // Why settle first: `cat`'s echo can still move the cursor to its own line under load.
  let settledCaret = ''
  await expect
    .poll(
      async () => {
        const next = JSON.stringify(record(await call('imeRect', [0])).caret)
        const stable = next === settledCaret
        settledCaret = next
        return stable
      },
      { intervals: [250] }
    )
    .toBe(true)
  const caretStart = rect(record(await call('imeRect', [0])).caret)
  const ime = record(await call('imeRect', [4]))
  const caret = rect(ime.caret)
  const view = rect(ime.view)
  expect(caret.x).toBeGreaterThan(caretStart.x)
  expect(caret.x).toBeGreaterThanOrEqual(view.x)
  expect(caret.x).toBeLessThanOrEqual(view.x + view.width)
  expect(caret.y).toBeGreaterThanOrEqual(view.y)
  expect(caret.y + caret.height).toBeLessThanOrEqual(view.y + view.height + 1)
  expect(caret.height).toBeGreaterThan(0)
  await call('insertText', ['日本語'])
  await expect.poll(async () => record(await call('markedText', [null])).hasMarkedText).toBe(false)
  await expect.poll(paneContent).toContain('cat日本語')

  // Dictation and Emoji & Symbols both commit through insertText (on a dispatched app event).
  await call('insertText', [' 😀 dictated'])
  await expect.poll(paneContent).toContain('日本語 😀 dictated')
  await call('key', ['\r', KEY_RETURN])
  await expect.poll(paneContent).toContain('日本語 😀 dictated日本語 😀 dictated')
  expect(await paneContent()).not.toContain('にほんご')

  // Services: a service's text goes through Orca's paste pipeline; the selection goes out.
  expect(record(await call('services', ['validate']))).toEqual({ sends: false, takes: true })
  expect(await call('services', ['read', 'from a service'])).toBe(true)
  await expect.poll(paneContent).toContain('from a service')
  await call('key', ['\r', KEY_RETURN])
  await expect.poll(paneContent).toContain('from a servicefrom a service')
  await call('action', ['select_all'])
  expect(record(await call('services', ['validate'])).sends).toBe(true)
  expect(String(await call('services', ['write']))).toContain('from a service')

  // The dictation app pastes with Cmd+V, which Edit > Paste sends to the focused pane.
  const savedClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await electronApp.evaluate(({ clipboard, BrowserWindow }) => {
      clipboard.writeText('from the clipboard')
      BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        ?.webContents.send('ui:appMenuPaste')
    })
    await expect.poll(paneContent).toContain('from the clipboard')
  } finally {
    await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)
  }
  await call('key', ['\r', KEY_RETURN])
  await expect.poll(paneContent).toContain('from the clipboardfrom the clipboard')

  // VoiceOver reads the viewport as a text area; assistive writes type at the prompt.
  await expect
    .poll(async () => record(await call('accessibility')).value)
    .toEqual(expect.stringContaining('from the clipboard'))
  const accessibility = record(await call('accessibility'))
  expect(accessibility).toMatchObject({
    isElement: true,
    role: 'AXTextArea',
    label: 'Terminal',
    selectedTextSettable: true
  })
  expect(accessibility.numberOfCharacters).toBe(String(accessibility.value).length)
  await call('accessibilitySet', ['selectedText', 'voice control'])
  await call('accessibilitySet', ['value', ' appended'])
  await call('key', ['\r', KEY_RETURN])
  await expect.poll(paneContent).toContain('voice control appendedvoice control appended')
  await call('key', ['c', KEY_C, CONTROL])
})

test('native panes fire double-tap bindings and guard password prompts', async ({
  orcaPage,
  electronApp
}) => {
  const { ptyId, call, paneContent } = await setupNativePane(orcaPage, electronApp)
  const sidebarOpen = () => orcaPage.evaluate(() => window.__store?.getState().sidebarOpen)
  const shiftTap = async (): Promise<void> => {
    await call('flags', [KEY_SHIFT, SHIFT])
    await call('flags', [KEY_SHIFT, 0])
  }

  // Double tap: a user's DoubleTap+Shift binding fires from a native pane, through the same
  // detector, so a key typed between the taps still breaks the gesture.
  await orcaPage.evaluate(async () => {
    await window.api.keybindings.setAction({
      actionId: 'sidebar.left.toggle',
      bindings: ['DoubleTap+Shift']
    })
  })
  await expect
    .poll(async () => {
      const chords = await nativeTerminalDebug(electronApp, 'forwardedChords')
      return Array.isArray(chords) && chords.some((chord) => record(chord).keyCode === KEY_SHIFT)
    })
    .toBe(true)
  const before = await sidebarOpen()
  await shiftTap()
  await call('key', ['a', KEY_A])
  await shiftTap()
  await orcaPage.waitForTimeout(500)
  expect(await sidebarOpen()).toBe(before)
  await shiftTap()
  await shiftTap()
  await expect.poll(sidebarOpen).toBe(!before)
  await call('key', ['c', KEY_C, CONTROL])

  // Secure Keyboard Entry, simulated so the test never blinds the desktop's keyboard monitors:
  // it follows a local password prompt (canonical, echo off) only while the pane has the keys.
  const secure = async () => record(await call('secureInput'))
  try {
    await call('secureInput', [true])
    await expect.poll(async () => String((await secure()).tty)).toMatch(/^\/dev\/ttys\d+$/)
    expect(await secure()).toMatchObject({ enabled: false, badge: false })
    await execInTerminal(
      orcaPage,
      ptyId,
      "stty -echo; read secret; stty echo; printf 'SECURE-%s\\n' DONE"
    )
    await expect
      .poll(secure)
      .toMatchObject({ passwordInput: true, enabled: true, owner: true, badge: true })

    // Hidden under DOM UI, the pane loses the keyboard and secure input with it.
    await orcaPage.evaluate(() => {
      const overlay = document.createElement('div')
      overlay.id = 'native-secure-input-overlay'
      overlay.setAttribute('role', 'dialog')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'
      document.body.appendChild(overlay)
    })
    await expect.poll(secure).toMatchObject({ enabled: false, badge: false })
    await orcaPage.evaluate(() => document.getElementById('native-secure-input-overlay')?.remove())
    await expect.poll(async () => record(await call('state')).hidden).toBe(false)
    await call('focus')
    await expect.poll(secure).toMatchObject({ enabled: true, badge: true })

    for (const character of 'hunter2') {
      await call('key', [character, 0])
    }
    await call('key', ['\r', KEY_RETURN])
    await expect.poll(paneContent).toContain('SECURE-DONE')
    expect(await paneContent()).not.toContain('hunter2')
    await expect.poll(secure).toMatchObject({ passwordInput: false, enabled: false, badge: false })
  } finally {
    await call('secureInput', [false])
  }
  expect(await secure()).toMatchObject({ simulated: false, enabled: false })
})
