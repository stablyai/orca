import type { CDPSession } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import { dispatchPlainEnter } from './terminal-ime-cdp-composition'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { applyImePlatformPolicy } from './terminal-ime-platform-policy'

// #22442/#28213: fcitx4/Sogou owns its preedit/candidate window and sends no Chromium composition session.
// Recorded letter keydowns are swallowed (only keyups arrive); candidate Space/digit keydown carries candidate text in keypress/insertText.
// CDP keyDown with candidate text reproduces the sequence; see the fcitx4-sogou-gtk-im-module trace fixture.

async function dispatchLetterKeyupOnly(
  session: CDPSession,
  key: string,
  code: string,
  keyCode: number
): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  })
}

/** A key press whose keydown names `key` but whose keypress and text insertion carry `text`. */
async function dispatchKeyCommitting(
  session: CDPSession,
  key: string,
  code: string,
  keyCode: number,
  text: string
): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    text,
    unmodifiedText: text
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  })
}

// CDP exercises Linux renderer policy and PTY bytes; it does not run native fcitx4/Sogou.
test('Linux Sogou candidate picks send the candidate, not the selector, to the PTY', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  await applyImePlatformPolicy(orcaPage, 'linux')
  const arena = await openTerminalImePaneArena(orcaPage)
  const reader = createTerminalImeByteReader(testRepoPath, 1)
  let completed = false
  try {
    await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)

    // Space picks the first candidate.
    await dispatchLetterKeyupOnly(arena.session, 'n', 'KeyN', 78)
    await dispatchLetterKeyupOnly(arena.session, 'i', 'KeyI', 73)
    await dispatchKeyCommitting(arena.session, ' ', 'Space', 32, '你')

    // A digit picks a later candidate.
    await dispatchLetterKeyupOnly(arena.session, 'h', 'KeyH', 72)
    await dispatchLetterKeyupOnly(arena.session, 'a', 'KeyA', 65)
    await dispatchLetterKeyupOnly(arena.session, 'o', 'KeyO', 79)
    await dispatchKeyCommitting(arena.session, '3', 'Digit3', 51, '浩')

    // With the IME off, Space, letters and digits are ordinary terminal input.
    for (const [key, code, keyCode] of [
      [' ', 'Space', 32],
      ['l', 'KeyL', 76],
      ['s', 'KeyS', 83],
      ['7', 'Digit7', 55]
    ] as const) {
      await dispatchKeyCommitting(arena.session, key, code, keyCode, key)
    }

    await dispatchPlainEnter(arena.session)
    expect(await waitForTerminalImeBytes(orcaPage, reader)).toEqual([
      Buffer.from('你浩 ls7\n').toString('hex')
    ])
    completed = true
  } finally {
    removeTerminalImeByteReader(reader)
    await closeTerminalImePaneArena(arena, testInfo, 'linux-claimed-preedit-selector', !completed)
  }
})
