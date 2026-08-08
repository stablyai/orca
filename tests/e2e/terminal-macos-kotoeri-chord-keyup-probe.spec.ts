import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  ABC_ID,
  bounceFocus,
  enableInputSource,
  KEY,
  KOTOERI_ROMAJI_ID,
  KOTOERI_ROMAJI_PARENT_ID,
  pressChord,
  selectInputSource,
  TWO_SET_KOREAN_ID,
  typeKeyCodes
} from './macos-input-source-driver'
import {
  installChordProbe,
  readActiveComposition,
  readChordProbe
} from './renderer-chord-event-probe'
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
