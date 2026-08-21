import type { CDPSession, Page, TestInfo } from '@stablyai/playwright-test'
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
  type TerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import {
  dispatchObservedIbusHangulMixedSequence,
  dispatchObservedIbusHangulRetainedCommitSequence
} from './terminal-ime-observed-event-sequences'

test.describe.configure({ mode: 'serial' })

type TraceAssertion = (trace: TerminalImeBoundaryTrace) => void

async function runExactByteScenario(
  page: Page,
  testInfo: TestInfo,
  testRepoPath: string,
  expectedText: string,
  dispatchInput: (page: Page) => Promise<void>,
  assertTrace: TraceAssertion
): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)

  const ptyId = await waitForActivePanePtyId(page)
  const reader = createTerminalImeByteReader(testRepoPath, 1)
  let completed = false
  let receivedBytes: string[] = []
  try {
    await startTerminalImeByteReader(page, ptyId, reader)
    await focusActiveTerminalInput(page)
    await installTerminalImeBoundaryProbe(page)
    await dispatchInput(page)

    receivedBytes = await waitForTerminalImeBytes(page, reader)
    const expectedBytes = Buffer.from(`${expectedText}\n`).toString('hex')
    expect(receivedBytes).toEqual([expectedBytes])

    const trace = await readTerminalImeBoundaryTrace(page)
    expect(trace.onData.join('')).toBe(`${expectedText}\r`)
    assertTrace(trace)
    completed = true
  } finally {
    await attachTerminalImeBoundaryEvidence(page, testInfo, 'terminal-ime-boundaries', {
      expectedText,
      receivedBytes
    }).catch(() => undefined)
    await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
    if (!completed) {
      await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
    }
    removeTerminalImeByteReader(reader)
  }
}

async function dispatchRepeatedConversion(
  page: Page,
  frames: string[],
  committedText: string
): Promise<void> {
  const session: CDPSession = await page.context().newCDPSession(page)
  try {
    for (let repetition = 0; repetition < 2; repetition += 1) {
      for (const frame of frames) {
        await session.send('Input.imeSetComposition', {
          text: frame,
          selectionStart: frame.length,
          selectionEnd: frame.length
        })
      }
      await session.send('Input.insertText', { text: committedText })
    }
    await page.keyboard.press('Enter')
  } finally {
    await session.detach()
  }
}

test.describe('Terminal IME exact-byte forwarding', () => {
  test.skip(process.platform !== 'linux', 'Linux composition order is covered by this suite')

  test('replays the observed IBus Hangul mixed-input order through xterm and the PTY', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runExactByteScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      '한abc글',
      dispatchObservedIbusHangulMixedSequence,
      (trace) => {
        const commits = trace.dom
          .filter((event) => event.type === 'input' && event.inputType === 'insertText')
          .map((event) => event.data)
        expect(commits).toEqual(expect.arrayContaining(['한', '글']))
      }
    )
  })

  test('keeps retained Hangul commits and stale fallbacks in their transactions', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runExactByteScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      '테a스',
      dispatchObservedIbusHangulRetainedCommitSequence,
      (trace) => {
        const starts = trace.dom.filter((event) => event.type === 'compositionstart')
        expect(starts).toHaveLength(2)
        expect(trace.onData.join('')).not.toContain('\x7f')
      }
    )
  })

  for (const scenario of [
    { name: 'Japanese', frames: ['に', 'にほんご', '日本語'], committedText: '日本語' },
    { name: 'Chinese', frames: ['n', 'ni', '你好'], committedText: '你好' }
  ]) {
    test(`does not suppress repeated legitimate ${scenario.name} conversions`, async ({
      orcaPage,
      testRepoPath
    }, testInfo) => {
      await runExactByteScenario(
        orcaPage,
        testInfo,
        testRepoPath,
        scenario.committedText.repeat(2),
        (page) => dispatchRepeatedConversion(page, scenario.frames, scenario.committedText),
        (trace) => {
          const commits = trace.dom.filter(
            (event) => event.type === 'compositionend' && event.data === scenario.committedText
          )
          expect(commits).toHaveLength(2)
        }
      )
    })
  }
})
