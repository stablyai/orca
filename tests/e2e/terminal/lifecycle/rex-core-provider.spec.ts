import { createTerminalTabFromMenu } from '../layout/terminal-tab-menu'
import { addFolderWorkspace } from '../../layout/publication/terminal-layout-journeys'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { createRestartSession } from '../../desktop/electron-fixtures/orca-restart'
import {
  bootstrapFirstLaunch,
  bootstrapRestoredLaunch
} from '../retention/terminal-restart-persistence'
import { waitForSessionReady, switchToWorktree } from '../../desktop/renderer-probes/store'
import { focusActiveTerminalInput, waitForActivePanePtyId } from '../input/terminal'
import { getTerminalContent, readPaneIdentitySnapshot } from '../layout/terminal-pane-identity'

const socket = process.env.ORCA_E2E_REX_SOCKET
const wasm = process.env.ORCA_E2E_REX_WASM
test.skip(
  process.platform !== 'darwin' || !socket || !wasm,
  'Requires isolated real Rex and verified WASM'
)

test('local Rex opt-in shares a shell with independent Rex CLI and retains its live identity across restart', async ({
  seededRepoPath
}, testInfo) => {
  if (!socket || !wasm) {
    throw new Error('Missing native Rex fixture')
  }
  const session = createRestartSession(testInfo, {
    ORCA_E2E_REX_SOCKET: socket,
    ORCA_E2E_REX_WASM: wasm
  })
  let current: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    const profilePath = join(session.userDataDir, 'orca-data.json')
    const profile = JSON.parse(await readFile(profilePath, 'utf8'))
    await writeFile(
      profilePath,
      JSON.stringify({
        ...profile,
        settings: {
          ...profile.settings,
          terminalLocalBackend: 'rex',
          uiLanguage: 'en',
          terminalDefaultShell: '/bin/bash',
          terminalScopeHistoryByWorktree: true
        }
      })
    )
    current = await session.launch()
    const { worktreeId, ptyId } = await bootstrapFirstLaunch(current.page, seededRepoPath)
    expect(ptyId).toMatch(/(?:^|@@)rex-/)
    const pane = await readPaneIdentitySnapshot(current.page)
    expect(pane?.activeLeafId).toBeTruthy()
    await focusActiveTerminalInput(current.page)
    await current.page.keyboard.type("printf 'REX_CORE_%s\\n' HISTORY")
    await current.page.keyboard.press('Enter')
    await expect.poll(() => getTerminalContent(current!.page)).toContain('REX_CORE_HISTORY')
    const root = join(session.userDataDir, 'rex-live-pty')
    const files = (await readdir(root)).filter((name) => name.endsWith('.json'))
    expect(files).toHaveLength(1)
    const record = JSON.parse(await readFile(join(root, files[0]), 'utf8'))
    expect(record.id).toBe(ptyId)
    const result = await promisify(execFile)(
      'rex',
      [
        '-S',
        `unix://${socket}`,
        '--autostart=false',
        'api',
        'call',
        'com.superlogical.terminal.format',
        JSON.stringify({
          session_id: record.sessionId,
          block_id: record.blockId,
          args: { format: 'text' }
        })
      ],
      { encoding: 'utf8', timeout: 8000 }
    )
    expect(JSON.parse(result.stdout).content).toContain('REX_CORE_HISTORY')
    await current.page.screenshot({ path: testInfo.outputPath('rex-native-terminal.png') })
    // Persist opt-out through the real settings path, not the profile backup file.
    await current.page.evaluate(() =>
      window.__store!.getState().updateSettingsOrThrow({ terminalLocalBackend: 'default' })
    )
    await expect
      .poll(() =>
        current!.page.evaluate(() => window.__store!.getState().settings?.terminalLocalBackend)
      )
      .toBe('default')
    await session.close(current.app)
    current = undefined
    current = await session.launch()
    await waitForSessionReady(current.page)
    await expect
      .poll(() =>
        current!.page.evaluate(() => window.__store!.getState().settings?.terminalLocalBackend)
      )
      .toBe('default')
    await switchToWorktree(current.page, worktreeId)
    await bootstrapRestoredLaunch(current.page, worktreeId)
    expect(await waitForActivePanePtyId(current.page, 30_000)).toBe(ptyId)
    expect((await readPaneIdentitySnapshot(current.page))?.activeLeafId).toBe(pane?.activeLeafId)
    await expect.poll(() => getTerminalContent(current!.page, 16000)).toContain('REX_CORE_HISTORY')
    await focusActiveTerminalInput(current.page)
    await current.page.keyboard.type("printf 'REX_CORE_%s\\n' LIVE")
    await current.page.keyboard.press('Enter')
    await expect.poll(() => getTerminalContent(current!.page, 16000)).toContain('REX_CORE_LIVE')
    const same = JSON.parse(await readFile(join(root, files[0]), 'utf8'))
    expect(same.rootPid).toBe(record.rootPid)
    expect(same.incarnationId).toBe(record.incarnationId)
    const newTab = await createTerminalTabFromMenu(current.page)
    await expect
      .poll(async () => {
        const snapshot = await readPaneIdentitySnapshot(current!.page)
        return snapshot?.tabId === newTab && snapshot.panes.some((pane) => pane.ptyId !== null)
      })
      .toBe(true)
    const standard = await waitForActivePanePtyId(current.page, 30_000)
    expect(standard).not.toMatch(/(?:^|@@)rex-/)
    expect(standard).not.toBe(ptyId)
    await focusActiveTerminalInput(current.page)
    await current.page.keyboard.type("printf 'STD_CORE_%s\\n' LIVE")
    await current.page.keyboard.press('Enter')
    await expect.poll(() => getTerminalContent(current!.page)).toContain('STD_CORE_LIVE')
    await current.page.screenshot({ path: testInfo.outputPath('standard-terminal.png') })
    await current.page.evaluate(() =>
      window.__store!.getState().updateSettingsOrThrow({ terminalLocalBackend: 'rex' })
    )
    const folder = await addFolderWorkspace(current.page)
    try {
      await expect
        .poll(() => current!.page.evaluate(() => window.__store!.getState().activeWorktreeId))
        .toBe(folder.worktreeId)
      const folderPty = await waitForActivePanePtyId(current.page, 30_000)
      expect(folderPty).toMatch(/(?:^|@@)rex-/)
      expect(folderPty).not.toBe(ptyId)
      await focusActiveTerminalInput(current.page)
      await current.page.keyboard.type("printf 'FOLDER_CORE_%s\\n' LIVE")
      await current.page.keyboard.press('Enter')
      await expect.poll(() => getTerminalContent(current!.page)).toContain('FOLDER_CORE_LIVE')
      await expect
        .poll(async () => (await readdir(root)).filter((name) => name.endsWith('.json')).length)
        .toBe(2)
      await focusActiveTerminalInput(current.page)
      await current.page.keyboard.type('exit 7')
      await current.page.keyboard.press('Enter')
      await expect
        .poll(async () => (await readdir(root)).filter((name) => name.endsWith('.json')))
        .toEqual(files)
      // A different live Rex pane retains its original identity.
      expect(JSON.parse(await readFile(join(root, files[0]), 'utf8')).incarnationId).toBe(
        record.incarnationId
      )
    } finally {
      folder.cleanup()
    }
  } finally {
    await session.dispose(current?.app)
  }
})
