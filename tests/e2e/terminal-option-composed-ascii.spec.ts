// Option composition must survive kitty negotiation (#14024, #20171, #20850).

import { test, expect } from './helpers/orca-app'
import { focusActiveTerminalInput, waitForTerminalOutput } from './helpers/terminal'
import { clearTerminalPtyWriteLog as clearPtyWriteLog } from './helpers/terminal-pty-write-spy'
import {
  setMacOptionAsAlt,
  pressOptionComposedKey,
  setUpOptionKeyboardPane,
  publishMacKeyboardLayout,
  waitForPaneOptionAsAlt,
  pressChromiumOptionPunctuation
} from './terminal-option-key-input'

test.describe('Option-composed text in a kitty-keyboard pane', () => {
  test.skip(process.platform !== 'darwin', 'Option composition is a macOS-only input path (#14024)')

  test('the settings control enables punctuation shortcuts and keeps the other Option side as text', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp, 7)
    await orcaPage.evaluate(async () => {
      const state = window.__store?.getState()
      await state?.updateSettings({ uiLanguage: 'en' })
      state?.openSettingsTarget({ pane: 'terminal', repoId: null })
      state?.openSettingsPage()
      state?.setSettingsSearchQuery('Option as Alt')
    })
    const control = orcaPage.getByRole('radiogroup', { name: 'Option as Alt', exact: true })
    await expect(
      orcaPage.getByText(/Choose Both for Option shortcuts, Off for accents and symbols/)
    ).toBeVisible()
    const keys = [
      { key: '…', code: 'Semicolon', codePoint: 59 },
      { key: '≥', code: 'Period', codePoint: 46 },
      { key: '≤', code: 'Comma', codePoint: 44 }
    ]
    for (const [label, setting] of [
      ['Both', 'true'],
      ['Left', 'left'],
      ['Right', 'right']
    ] as const) {
      await control.getByRole('radio', { name: label, exact: true }).click()
      await expect
        .poll(() =>
          orcaPage.evaluate(() => window.__store?.getState().settings?.terminalMacOptionAsAlt)
        )
        .toBe(setting)
      await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
      for (const side of ['left', 'right'] as const) {
        await clearPtyWriteLog(electronApp)
        for (const key of keys) {
          await pressOptionComposedKey(orcaPage, { ...key, side })
        }
        const isAlt = setting === 'true' || setting === side
        const expected = keys
          .map(
            ({ key, codePoint }) => `${isAlt ? `\x1b[${codePoint};3u` : key}\x1b[${codePoint};3:3u`
          )
          .join('')
        await expect.poll(joinedWrites).toBe(expected)
      }
      await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        state?.openSettingsPage()
        state?.setSettingsSearchQuery('Option as Alt')
      })
    }
  })

  test('Chromium Option punctuation produces text in compose mode and shortcuts in Both mode', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp, 7)
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    try {
      for (const setting of ['false', 'true'] as const) {
        await setMacOptionAsAlt(orcaPage, setting)
        await clearPtyWriteLog(electronApp)
        for (const key of [
          { key: '…', code: 'Semicolon', base: ';', codePoint: 59, windowsVirtualKeyCode: 186 },
          { key: '≥', code: 'Period', base: '.', codePoint: 46, windowsVirtualKeyCode: 190 },
          { key: '≤', code: 'Comma', base: ',', codePoint: 44, windowsVirtualKeyCode: 188 }
        ]) {
          await pressChromiumOptionPunctuation(cdp, key)
        }
        const expected = [
          ['…', 59],
          ['≥', 46],
          ['≤', 44]
        ]
          .map(
            ([key, codePoint]) =>
              `${setting === 'true' ? `\x1b[${codePoint};3u` : key}\x1b[${codePoint};3:3u`
          )
          .join('')
        await expect.poll(joinedWrites).toBe(expected)
        if (setting === 'false') {
          for (const glyph of ['…', '≥', '≤']) {
            await waitForTerminalOutput(orcaPage, glyph)
          }
        }
      }
    } finally {
      await cdp.detach()
    }
  })

  test('Auto follows ABC and composing input sources without replacing explicit Option settings', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp, 7)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
    })
    await setMacOptionAsAlt(orcaPage, 'auto')
    const abc = 'com.apple.keylayout.ABC'
    const international = 'com.apple.keylayout.USInternational-PC'
    const pinyin = 'com.apple.inputmethod.SCIM.ITABC'
    const keyCharacters = {
      Semicolon: { unmodified: ';', shifted: ':' },
      Period: { unmodified: '.', shifted: '>' },
      Comma: { unmodified: ',', shifted: '<' }
    }
    const period = { key: '≥', code: 'Period', base: '.', windowsVirtualKeyCode: 190 }
    let generation = Date.now()
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    try {
      for (const inputSourceId of [abc, international, abc, pinyin, abc, null, abc]) {
        await publishMacKeyboardLayout(
          electronApp,
          inputSourceId
            ? {
                inputSourceId,
                layoutSourceId: inputSourceId === pinyin ? abc : inputSourceId,
                keyCharacters
              }
            : null,
          ++generation
        )
        const isAlt = inputSourceId === abc
        await waitForPaneOptionAsAlt(orcaPage, isAlt)
        await orcaPage.evaluate(() => {
          const state = window.__store?.getState()
          state?.openSettingsTarget({ pane: 'terminal', repoId: null })
          state?.openSettingsPage()
          state?.setSettingsSearchQuery('Option as Alt')
        })
        const control = orcaPage.getByRole('radiogroup', { name: 'Option as Alt', exact: true })
        await expect(control.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute(
          'aria-checked',
          'true'
        )
        await expect(
          orcaPage.getByText(
            isAlt
              ? /Auto — detected: ABC or U.S. — Option sends Alt\/Esc sequences/
              : inputSourceId
                ? /Auto — detected: layout uses Option to compose characters/
                : /Auto — detected: unknown layout — Option composes characters/
          )
        ).toBeVisible()
        await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
        await focusActiveTerminalInput(orcaPage)
        await clearPtyWriteLog(electronApp)
        await pressChromiumOptionPunctuation(cdp, period)
        await expect.poll(joinedWrites).toBe(`${isAlt ? '\x1b[46;3u' : '≥'}\x1b[46;3:3u`)
        await expect
          .poll(() =>
            orcaPage.evaluate(() => window.__store?.getState().settings?.terminalMacOptionAsAlt)
          )
          .toBe('auto')
      }
      await setMacOptionAsAlt(orcaPage, 'false')
      await waitForPaneOptionAsAlt(orcaPage, false)
      await clearPtyWriteLog(electronApp)
      await pressChromiumOptionPunctuation(cdp, period)
      await expect.poll(joinedWrites).toBe('≥\x1b[46;3:3u')
      await setMacOptionAsAlt(orcaPage, 'left')
      for (const inputSourceId of [international, abc]) {
        await publishMacKeyboardLayout(
          electronApp,
          { inputSourceId, layoutSourceId: inputSourceId, keyCharacters },
          ++generation
        )
        for (const side of ['left', 'right'] as const) {
          await clearPtyWriteLog(electronApp)
          await pressOptionComposedKey(orcaPage, { ...period, side })
          await expect
            .poll(joinedWrites)
            .toBe(`${side === 'left' ? '\x1b[46;3u' : '≥'}\x1b[46;3:3u`)
        }
        expect(
          await orcaPage.evaluate(() => window.__store?.getState().settings?.terminalMacOptionAsAlt)
        ).toBe('left')
      }
    } finally {
      await cdp.detach()
    }
  })

  test('configured Option punctuation keeps legacy Alt bytes without enhanced reporting', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp, 0)
    for (const setting of ['true', 'left', 'right'] as const) {
      await setMacOptionAsAlt(orcaPage, setting)
      await clearPtyWriteLog(electronApp)
      const side = setting === 'right' ? 'right' : 'left'
      for (const key of [
        { key: '…', code: 'Semicolon' },
        { key: '≥', code: 'Period' },
        { key: '≤', code: 'Comma' }
      ]) {
        await pressOptionComposedKey(orcaPage, { ...key, side })
      }
      await expect.poll(joinedWrites).toBe('\x1b;\x1b.\x1b,')
    }
  })

  test('types the composed character instead of reporting the physical Alt chord', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp)
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)

    // Turkish Q: the physical `q` key composes `@`.
    const dispatch = await pressOptionComposedKey(orcaPage, { key: '@', code: 'KeyQ' })
    expect(dispatch.keydownDefaultPrevented).toBe(true)

    await expect
      .poll(joinedWrites, {
        timeout: 5_000,
        message: 'Option-composed `@` never reached the PTY'
      })
      .toContain('@')
    // \x1b[113;3u is alt+q — the chord that swallowed the character in #14024.
    expect(await joinedWrites()).not.toContain('\x1b[113;3u')
  })

  test('types a composed character that also needs Shift', async ({ orcaPage, electronApp }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp)
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)

    // QWERTZ-class layouts put `\` on the shifted Option layer (Option+Shift+7),
    // where no other chord can reach it.
    const dispatch = await pressOptionComposedKey(orcaPage, {
      key: '\\',
      code: 'Digit7',
      shiftKey: true
    })
    expect(dispatch.keydownDefaultPrevented).toBe(true)

    await expect
      .poll(joinedWrites, {
        timeout: 5_000,
        message: 'Option+Shift-composed `\\` never reached the PTY'
      })
      .toContain('\\')
    expect(await joinedWrites()).not.toContain('\x1b[55;4u')
  })

  test('still reports the Alt chord when Option is configured as Alt', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp)
    await setMacOptionAsAlt(orcaPage, 'true')
    await clearPtyWriteLog(electronApp)

    const dispatch = await pressOptionComposedKey(orcaPage, { key: '@', code: 'KeyQ' })
    expect(dispatch.keydownDefaultPrevented).toBe(true)

    await expect
      .poll(joinedWrites, {
        timeout: 5_000,
        message: 'configured Option-as-Alt did not report the physical alt+q chord'
      })
      .toContain('\x1b[113;3u')
    expect(await joinedWrites()).not.toContain('@')
  })

  test('keeps non-ASCII Option glyphs as TUI hotkeys when configured as Alt', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp)
    await setMacOptionAsAlt(orcaPage, 'true')
    await clearPtyWriteLog(electronApp)

    // #8031: OMP-class TUIs bind Option+P, which composes the non-ASCII `π`.
    const dispatch = await pressOptionComposedKey(orcaPage, { key: 'π', code: 'KeyP' })
    expect(dispatch.keydownDefaultPrevented).toBe(true)

    await expect
      .poll(joinedWrites, {
        timeout: 5_000,
        message: 'Option+P did not reach the TUI as the alt+p hotkey'
      })
      .toContain('\x1b[112;3u')
    expect(await joinedWrites()).not.toContain('π')
  })

  test('types all Polish letters once under Claude flags and updates the mounted pane setting', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp, 5)
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)
    const letters = [
      ['a', 'ą'],
      ['c', 'ć'],
      ['e', 'ę'],
      ['l', 'ł'],
      ['n', 'ń'],
      ['o', 'ó'],
      ['s', 'ś'],
      ['x', 'ź'],
      ['z', 'ż']
    ]
    for (const [base, key] of letters) {
      await pressOptionComposedKey(orcaPage, { key, code: `Key${base.toUpperCase()}` })
      await pressOptionComposedKey(orcaPage, {
        key: key.toUpperCase(),
        code: `Key${base.toUpperCase()}`,
        shiftKey: true
      })
    }
    await expect.poll(joinedWrites).toBe('ąĄćĆęĘłŁńŃóÓśŚźŹżŻ')
    await setMacOptionAsAlt(orcaPage, 'true')
    await clearPtyWriteLog(electronApp)
    await pressOptionComposedKey(orcaPage, { key: 'ą', code: 'KeyA' })
    await expect.poll(joinedWrites).toBe('\x1b[97;3u')
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)
    await pressOptionComposedKey(orcaPage, { key: 'ą', code: 'KeyA' })
    await expect.poll(joinedWrites).toBe('ą')
  })

  test('reports Polish associated text once under report-all flags', async ({
    orcaPage,
    electronApp
  }) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp, 29)
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)
    await pressOptionComposedKey(orcaPage, { key: 'ą', code: 'KeyA' })
    await expect.poll(joinedWrites).toBe('\x1b[97;3;261u')
  })

  test('renders Polish words entered through Chromium keyboard events', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    const { joinedWrites } = await setUpOptionKeyboardPane(orcaPage, electronApp, 5)
    await setMacOptionAsAlt(orcaPage, 'false')
    await clearPtyWriteLog(electronApp)
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    const bases: Record<string, string> = {
      ą: 'a',
      ć: 'c',
      ę: 'e',
      ł: 'l',
      ń: 'n',
      ó: 'o',
      ś: 's',
      ź: 'x',
      ż: 'z'
    }
    const phrase = 'zażółć wcześniej łącznie'
    try {
      for (const key of phrase) {
        const base = bases[key] ?? key
        const code = key === ' ' ? 'Space' : `Key${base.toUpperCase()}`
        const modifiers = bases[key] ? 1 : 0
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          code,
          modifiers,
          text: key,
          unmodifiedText: base
        })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
      }
      await expect.poll(joinedWrites).toBe(phrase)
      await waitForTerminalOutput(orcaPage, phrase)
      await orcaPage.screenshot({ path: testInfo.outputPath('polish-words.png') })
    } finally {
      await cdp.detach()
    }
  })
})
