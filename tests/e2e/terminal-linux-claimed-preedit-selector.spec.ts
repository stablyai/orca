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

/**
 * Sogou on fcitx keeps its preedit and candidate list in its own window and opens no Chromium
 * composition session, so the composition-scoped candidate guards are idle when the user presses
 * the selector. Space and candidate digits then reached the PTY as literal text ahead of the
 * commit (#22442). What the IME does still deliver is the claimed `keyCode 229` letter keydown,
 * and that is what this spec replays.
 */

/** The letter keydown shape fcitx delivers once it has claimed the key for a preedit. */
async function dispatchClaimedLetter(
  session: CDPSession,
  code: string,
  letter: string,
  keyCode: number
): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Process',
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: keyCode
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: letter,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  })
}

/** A selector pressed as a plain key, which is how it arrives with no composition session. */
async function dispatchPlainKey(
  session: CDPSession,
  key: string,
  code: string,
  keyCode: number
): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    text: key,
    unmodifiedText: key
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  })
}

// CDP exercises Linux renderer policy and PTY bytes; it does not simulate native fcitx5/Sogou.
test('Linux candidate selectors reach the IME, not the PTY, for a preedit with no composition session', async ({
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
    await dispatchClaimedLetter(arena.session, 'KeyN', 'n', 78)
    await dispatchClaimedLetter(arena.session, 'KeyI', 'i', 73)
    await dispatchPlainKey(arena.session, ' ', 'Space', 32)
    await arena.session.send('Input.insertText', { text: '你' })

    // A digit picks a later candidate.
    await dispatchClaimedLetter(arena.session, 'KeyH', 'h', 72)
    await dispatchClaimedLetter(arena.session, 'KeyA', 'a', 65)
    await dispatchPlainKey(arena.session, '3', 'Digit3', 51)
    await arena.session.send('Input.insertText', { text: '好' })

    // The round is over: the next Space is ordinary terminal input again.
    await dispatchPlainKey(arena.session, ' ', 'Space', 32)
    // And so is ordinary Latin typing that the IME never claimed.
    for (const [key, code, keyCode] of [
      ['l', 'KeyL', 76],
      ['s', 'KeyS', 83]
    ] as const) {
      await dispatchPlainKey(arena.session, key, code, keyCode)
    }
    await dispatchPlainKey(arena.session, '7', 'Digit7', 55)

    await dispatchPlainEnter(arena.session)
    expect(await waitForTerminalImeBytes(orcaPage, reader)).toEqual([
      Buffer.from('你好 ls7\n').toString('hex')
    ])
    completed = true
  } finally {
    removeTerminalImeByteReader(reader)
    await closeTerminalImePaneArena(arena, testInfo, 'linux-claimed-preedit-selector', !completed)
  }
})
