import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { runProcess } from '../../../src/shared/child-process/run-process'

/** A real child process proves that completion reaches the external caller through IPC. */
export function startExternalEditorCli(userDataDir: string, args: string[]) {
  const controller = new AbortController()
  let finished = false
  const result = runProcess({
    program: process.execPath,
    args: [path.join(process.cwd(), 'out', 'cli', 'index.js'), ...args],
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH: userDataDir,
      ORCA_CLI_CWD: '',
      ORCA_ENVIRONMENT: '',
      ORCA_PAIRING_CODE: '',
      ORCA_REMOTE_PAIRING: '',
      ORCA_BACKGROUND_LAUNCH: '1'
    },
    timeoutMs: 90_000,
    maxOutputBytes: 32 * 1024,
    signal: controller.signal,
    terminationBarrier: true
  })
  void result.then(
    () => {
      finished = true
    },
    () => {
      finished = true
    }
  )
  return {
    result,
    isPending: () => !finished,
    cancel: async () => {
      controller.abort()
      await result.catch(() => undefined)
    }
  }
}

/** CDP capture keeps verification from activating the user's desktop windows. */
export async function captureExternalEditorEvidence(page: Page, testInfo: TestInfo, name: string) {
  const session = await page.context().newCDPSession(page)
  try {
    const screenshot = await session.send('Page.captureScreenshot', { format: 'png' })
    const outputPath = testInfo.outputPath(`${name}.png`)
    await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'))
    await testInfo.attach(name, { path: outputPath, contentType: 'image/png' })
  } finally {
    await session.detach()
  }
}
