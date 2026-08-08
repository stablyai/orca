import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
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
  readTerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'

const TWO_SET_KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'

function typeNativeTwoSetKorean(processId: number, keyCodes: readonly number[]): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    `tell application "System Events" to key code {${keyCodes.join(', ')}}`
  ])
}

function typeNativeTwoSetKoreanPreedit(processId: number, keyCodes: readonly number[]): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    'tell application "System Events"',
    '-e',
    `repeat with currentKeyCode in {${keyCodes.join(', ')}}`,
    '-e',
    'key code (currentKeyCode as integer)',
    '-e',
    'delay 0.1',
    '-e',
    'end repeat',
    '-e',
    'end tell'
  ])
}

function commitNativeComposition(shift = false): void {
  const modifier = shift ? ' using shift down' : ''
  execFileSync('osascript', ['-e', `tell application "System Events" to key code 36${modifier}`])
}

async function readActiveComposition(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    const composition = textarea?.parentElement?.querySelector<HTMLElement>(
      '.composition-view.active'
    )
    return composition?.textContent?.replaceAll('\u200e', '') ?? null
  })
}

async function runNativeScenario(
  page: Page,
  testInfo: TestInfo,
  testRepoPath: string,
  processId: number,
  keyCodes: readonly number[],
  expectedText: string,
  preCommit?: { committedText: string; preeditText: string; shiftEnter?: boolean },
  ordinaryControl = false
): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await expect(page.evaluate(() => window.api.app.getKeyboardInputSourceId())).resolves.toBe(
    TWO_SET_KOREAN_ID
  )

  const ptyId = await waitForActivePanePtyId(page)
  let reader = createTerminalImeByteReader(testRepoPath, ordinaryControl ? 2 : 1)
  let completed = false
  try {
    await startTerminalImeByteReader(page, ptyId, reader)
    await focusActiveTerminalInput(page)
    await installTerminalImeBoundaryProbe(page)
    if (preCommit) {
      typeNativeTwoSetKoreanPreedit(processId, keyCodes)
      await expect.poll(() => readActiveComposition(page)).toBe(preCommit.preeditText)
      await expect
        .poll(async () => (await readTerminalImeBoundaryTrace(page)).onData.join(''))
        .toBe(preCommit.committedText)
      commitNativeComposition(preCommit.shiftEnter)
    } else {
      typeNativeTwoSetKorean(processId, keyCodes)
    }

    if (ordinaryControl) {
      await expect
        .poll(async () => (await readTerminalImeBoundaryTrace(page)).onData.join(''))
        .toBe(`${expectedText}\r`)
      await page.keyboard.type('ordinary')
      await page.keyboard.press('Enter')
      expect(await waitForTerminalImeBytes(page, reader)).toEqual([
        Buffer.from(`${expectedText}\n`).toString('hex'),
        Buffer.from('ordinary\n').toString('hex')
      ])
    } else if (preCommit?.shiftEnter) {
      expect(await waitForTerminalImeBytes(page, reader)).toEqual([
        Buffer.from(`${expectedText}\x1b\n`).toString('hex')
      ])
      removeTerminalImeByteReader(reader)
      reader = createTerminalImeByteReader(testRepoPath, 1)
      await startTerminalImeByteReader(page, ptyId, reader)
      await page.keyboard.type('ordinary')
      await page.keyboard.press('Shift+Enter')
      expect(await waitForTerminalImeBytes(page, reader)).toEqual([
        Buffer.from('ordinary\x1b\n').toString('hex')
      ])
    } else {
      expect(await waitForTerminalImeBytes(page, reader)).toEqual([
        Buffer.from(`${expectedText}\n`).toString('hex')
      ])
    }
    const trace = await readTerminalImeBoundaryTrace(page)
    const expectedOnData = ordinaryControl
      ? `${expectedText}\rordinary\r`
      : preCommit?.shiftEnter
        ? `${expectedText}\x1b\rordinary\x1b\r`
        : `${expectedText}\r`
    expect(trace.onData.join('')).toBe(expectedOnData)
    completed = true
  } finally {
    await attachTerminalImeBoundaryEvidence(page, testInfo, 'native-macos-2set-boundaries').catch(
      () => undefined
    )
    await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
    if (!completed) {
      await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
    }
    removeTerminalImeByteReader(reader)
  }
}

async function activateLocalFolderWorkspace(page: Page, folderPath: string): Promise<void> {
  const workspaceKey = await page.evaluate(async (folderPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('Renderer store unavailable')
    }
    const group =
      store.getState().projectGroups.find((candidate) => candidate.executionHostId === 'local') ??
      (await store.getState().createProjectGroup('IME folder group'))
    if (!group) {
      throw new Error('Local project group unavailable')
    }
    const workspace = await store.getState().createFolderWorkspace({
      folderPath,
      name: 'IME folder workspace',
      projectGroupId: group.id
    })
    if (!workspace) {
      throw new Error('Folder workspace was not created')
    }
    store.getState().setActiveFolderWorkspace(workspace.id, 'local')
    return `folder:${workspace.id}`
  }, folderPath)
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
    .toBe(workspaceKey)
}

test.describe('Native macOS 2-Set Korean terminal input @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_KOREAN !== '1',
    'Requires macOS with 2-Set Korean selected and Accessibility access'
  )

  test('forwards physical Hangul input as exact PTY bytes', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      electronApp.process().pid!,
      [5, 40, 1, 15, 46, 3],
      '한글',
      { committedText: '한', preeditText: '글' }
    )
  })

  test('preserves leading vowels and composes the following syllable', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      electronApp.process().pid!,
      [31, 40, 0, 16, 36],
      'ㅐㅏ묘'
    )
  })

  test('flushes each syllable while the next remains in preedit', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      electronApp.process().pid!,
      [15, 40, 1, 40, 14, 40],
      '가나다',
      { committedText: '가나', preeditText: '다' }
    )
  })

  test('commits the final syllable before physical Shift+Enter', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      electronApp.process().pid!,
      [13, 40],
      '자',
      { committedText: '', preeditText: '자', shiftEnter: true }
    )
  })

  test('uses the same native owner in a folder workspace', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const folderPath = path.join(testRepoPath, 'ime-folder-workspace')
    mkdirSync(folderPath)
    await activateLocalFolderWorkspace(orcaPage, folderPath)
    await runNativeScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      electronApp.process().pid!,
      [5, 40, 1, 15, 46, 3, 36],
      '한글',
      undefined,
      true
    )
  })
})
