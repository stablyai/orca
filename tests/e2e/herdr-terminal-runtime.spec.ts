import type { ElectronApplication } from '@stablyai/playwright-test'
import { test } from './helpers/orca-app'
import {
  assertHerdrSplitPanes,
  assertLiveHerdrTerminal,
  assertRestoredHerdrTerminal,
  expectHerdrRuntimeSelection,
  openHerdrProjectTerminal,
  openTerminalRuntimeSettings,
  selectHerdrInSettings
} from './helpers/herdr-terminal-runtime'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'

test.describe.configure({ mode: 'serial' })
test.use({ seedTestRepo: false })

const daemonSelection = { source: 'daemon' as const }

test('settings selects the built-in daemon and a herdr terminal accepts input', async ({
  orcaPage,
  testRepoPath
}) => {
  await waitForSessionReady(orcaPage)
  await selectHerdrInSettings(orcaPage, daemonSelection)
  await openHerdrProjectTerminal(orcaPage, testRepoPath)
  await assertLiveHerdrTerminal(orcaPage, {
    prefix: 'HERDR-E2E',
    suffix: `${Date.now()}`
  })
})

test('herdr daemon terminal reattaches with its scrollback after restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  const markerPrefix = 'HERDR-E2E'
  const markerSuffix = `${Date.now()}`
  const marker = `${markerPrefix}${markerSuffix}`
  const appLogs: string[] = []
  const captureLogs = () => (chunk: string) => appLogs.push(chunk)

  try {
    const first = await session.launch({ onStderr: captureLogs() })
    app = first.app
    await waitForSessionReady(first.page)
    await selectHerdrInSettings(first.page, daemonSelection)
    const worktreeId = await openHerdrProjectTerminal(first.page, testRepoPath)
    await assertLiveHerdrTerminal(first.page, { prefix: markerPrefix, suffix: markerSuffix })

    await session.close(app)
    app = null

    const second = await session.launch({ onStderr: captureLogs() })
    app = second.app
    await waitForSessionReady(second.page)
    await assertRestoredHerdrTerminal(second.page, marker, { worktreeId }).catch((error) => {
      throw new Error(`${String(error)}\nApp logs:\n${appLogs.join('\n')}`)
    })
    await openTerminalRuntimeSettings(second.page)
    await expectHerdrRuntimeSelection(second.page, daemonSelection)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})

test('splitting a herdr daemon terminal keeps two herdr panes', async ({
  orcaPage,
  testRepoPath
}) => {
  await waitForSessionReady(orcaPage)
  await selectHerdrInSettings(orcaPage, daemonSelection)
  await openHerdrProjectTerminal(orcaPage, testRepoPath)
  await assertLiveHerdrTerminal(orcaPage, {
    prefix: 'HERDR-SPLIT-A',
    suffix: `${Date.now()}`
  })
  await assertHerdrSplitPanes(orcaPage, `HERDR-SPLIT-B${Date.now()}`)
})
