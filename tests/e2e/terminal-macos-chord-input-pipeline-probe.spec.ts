import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  disposeMainProcessInputProbe,
  installMainProcessInputProbe,
  readMainProcessInputProbe
} from './main-process-input-event-probe'
import {
  ABC_ID,
  bounceFocus,
  enableInputSource,
  KEY,
  KOTOERI_ROMAJI_ID,
  KOTOERI_ROMAJI_PARENT_ID,
  pressChord,
  pressChordWithSeparateModifier,
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
 * #12871 capture, not a gate. The renderer probe established that a Cmd chord's keyup never
 * reaches the page. It cannot say why. This records the same gesture one layer lower, at
 * Chromium's own input dispatch, so three candidates separate: the release never leaves the OS,
 * Orca's main-process handler consumes it, or it is dropped between Chromium and the page.
 *
 * The modifier's own release is recorded too, since a Meta keyup at this layer is what a
 * modifier-release-driven recovery would have to key off.
 */

const EVIDENCE_DIR = path.join(process.cwd(), 'test-results', 'terminal-ime-evidence')

function writeEvidence(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(path.join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 1)}\n`)
}

async function openFocusedTerminal(page: Page): Promise<void> {
  await waitForActiveWorktree(page)
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  await waitForActivePanePtyId(page)
  await focusActiveTerminalInput(page)
}

function requireProcessId(electronApp: ElectronApplication): number {
  const processId = electronApp.process().pid
  if (processId === undefined) {
    throw new Error('Electron process id unavailable')
  }
  return processId
}

test.describe('macOS chord input pipeline probe @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_KOREAN !== '1',
    'Requires macOS with native IME access and Accessibility permission'
  )

  test.afterEach(async ({ electronApp }) => {
    await disposeMainProcessInputProbe(electronApp).catch(() => {})
    selectInputSource(TWO_SET_KOREAN_ID)
  })

  test('ABC control: which layer still has the Cmd+Left release', async ({
    electronApp,
    orcaPage
  }) => {
    const processId = requireProcessId(electronApp)
    await openFocusedTerminal(orcaPage)

    selectInputSource(ABC_ID)
    bounceFocus(processId)
    await focusActiveTerminalInput(orcaPage)

    await installMainProcessInputProbe(electronApp)
    await installChordProbe(orcaPage)
    pressChord(processId, KEY.left, 'command')
    await orcaPage.waitForTimeout(800)
    pressChord(processId, KEY.left, 'option')
    await orcaPage.waitForTimeout(800)
    pressChord(processId, KEY.left)
    await orcaPage.waitForTimeout(800)

    const mainRows = await readMainProcessInputProbe(electronApp)
    const rendererRows = await readChordProbe(orcaPage)
    writeEvidence('abc-chord-pipeline-main.json', mainRows)
    writeEvidence('abc-chord-pipeline-renderer.json', rendererRows)
    console.log('ABC_MAIN_ROWS', JSON.stringify(mainRows))

    expect(mainRows.length).toBeGreaterThan(0)
  })

  test('Kotoeri: which layer still has the Cmd+Left release while さ is composing', async ({
    electronApp,
    orcaPage
  }) => {
    const processId = requireProcessId(electronApp)
    await openFocusedTerminal(orcaPage)

    enableInputSource(KOTOERI_ROMAJI_PARENT_ID)
    enableInputSource(KOTOERI_ROMAJI_ID)
    selectInputSource(KOTOERI_ROMAJI_ID)
    bounceFocus(processId)
    await focusActiveTerminalInput(orcaPage)

    typeKeyCodes(processId, [KEY.s, KEY.a])
    try {
      await expect
        .poll(() => readActiveComposition(orcaPage), { timeout: 6_000 })
        .toMatch(/[ぁ-ん]/)
    } catch {
      bounceFocus(processId)
      await focusActiveTerminalInput(orcaPage)
      typeKeyCodes(processId, [KEY.s, KEY.a])
      await expect
        .poll(() => readActiveComposition(orcaPage), { timeout: 10_000 })
        .toMatch(/[ぁ-ん]/)
    }

    await installMainProcessInputProbe(electronApp)
    await installChordProbe(orcaPage)
    pressChord(processId, KEY.left, 'command')
    await orcaPage.waitForTimeout(1_500)
    // A bare arrow afterwards shows the window still routes keys here at all.
    pressChord(processId, KEY.left)
    await orcaPage.waitForTimeout(800)

    const mainRows = await readMainProcessInputProbe(electronApp)
    const rendererRows = await readChordProbe(orcaPage)
    writeEvidence('kotoeri-chord-pipeline-main.json', mainRows)
    writeEvidence('kotoeri-chord-pipeline-renderer.json', rendererRows)
    console.log('KOTOERI_MAIN_ROWS', JSON.stringify(mainRows))

    typeKeyCodes(processId, [KEY.backspace, KEY.backspace])
    expect(mainRows.length).toBeGreaterThan(0)
  })

  test('Command released as its own key: is that release delivered', async ({
    electronApp,
    orcaPage
  }) => {
    const processId = requireProcessId(electronApp)
    await openFocusedTerminal(orcaPage)

    enableInputSource(KOTOERI_ROMAJI_PARENT_ID)
    enableInputSource(KOTOERI_ROMAJI_ID)
    selectInputSource(KOTOERI_ROMAJI_ID)
    bounceFocus(processId)
    await focusActiveTerminalInput(orcaPage)

    typeKeyCodes(processId, [KEY.s, KEY.a])
    await expect.poll(() => readActiveComposition(orcaPage), { timeout: 10_000 }).toMatch(/[ぁ-ん]/)

    await installMainProcessInputProbe(electronApp)
    await installChordProbe(orcaPage)
    pressChordWithSeparateModifier(processId, KEY.left, 'command')
    await orcaPage.waitForTimeout(1_500)

    const mainRows = await readMainProcessInputProbe(electronApp)
    const rendererRows = await readChordProbe(orcaPage)
    writeEvidence('kotoeri-separate-modifier-main.json', mainRows)
    writeEvidence('kotoeri-separate-modifier-renderer.json', rendererRows)
    console.log('SEPARATE_MODIFIER_MAIN_ROWS', JSON.stringify(mainRows))

    typeKeyCodes(processId, [KEY.backspace, KEY.backspace])
    expect(mainRows.length).toBeGreaterThan(0)
  })

  // Why Korean matters here: it commits on the chord and the platform replays the chord unmarked.
  // Keying recovery off the Command release would fire twice if that release still reported a
  // live composition, so the ordering of compositionend against it is what makes it safe.
  test('Korean: where compositionend falls against the Command release', async ({
    electronApp,
    orcaPage
  }) => {
    const processId = requireProcessId(electronApp)
    await openFocusedTerminal(orcaPage)

    selectInputSource(TWO_SET_KOREAN_ID)
    bounceFocus(processId)
    await focusActiveTerminalInput(orcaPage)

    typeKeyCodes(processId, [KEY.s])
    await expect
      .poll(() => readActiveComposition(orcaPage), { timeout: 10_000 })
      .toMatch(/[ㄱ-ㅣ가-힣]/)

    await installMainProcessInputProbe(electronApp)
    await installChordProbe(orcaPage)
    pressChordWithSeparateModifier(processId, KEY.left, 'command')
    await orcaPage.waitForTimeout(1_500)

    const mainRows = await readMainProcessInputProbe(electronApp)
    const rendererRows = await readChordProbe(orcaPage)
    writeEvidence('korean-separate-modifier-main.json', mainRows)
    writeEvidence('korean-separate-modifier-renderer.json', rendererRows)
    console.log('KOREAN_MAIN_ROWS', JSON.stringify(mainRows))

    typeKeyCodes(processId, [KEY.backspace, KEY.backspace])
    expect(rendererRows.length).toBeGreaterThan(0)
  })

  // The one assertion in this file rather than a recording: the release-keyed recovery has to
  // reach the shell, not merely resolve. Driven as a hand types it, so the Command release the
  // recovery keys off actually exists.
  test('Kotoeri + Cmd+Left reaches the pty as さ then line start', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    const processId = requireProcessId(electronApp)
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
      typeKeyCodes(processId, [KEY.s, KEY.a])
      await expect
        .poll(() => readActiveComposition(orcaPage), { timeout: 10_000 })
        .toMatch(/[ぁ-ん]/)

      pressChordWithSeparateModifier(processId, KEY.left, 'command')
      await orcaPage.waitForTimeout(1_200)

      // A live preedit eats the first Return; the second flushes the line.
      pressChord(processId, KEY.returnKey)
      let bytes = await waitForTerminalImeBytes(orcaPage, reader, 5_000).catch(() => [])
      if (bytes.length === 0) {
        pressChord(processId, KEY.returnKey)
        bytes = await waitForTerminalImeBytes(orcaPage, reader, 10_000).catch(() => [])
      }
      writeEvidence('kotoeri-command-release-pty.json', bytes)
      console.log('KOTOERI_COMMAND_PTY', JSON.stringify(bytes))

      // さ then \x01, in that order: xterm queues the chord behind the preedit and flushes both
      // on commit, so the chord cannot land ahead of the text being composed.
      expect(bytes.join('')).toContain('e3819501')
    } finally {
      removeTerminalImeByteReader(reader)
      selectInputSource(TWO_SET_KOREAN_ID)
    }
  })
})
