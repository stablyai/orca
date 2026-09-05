import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { runProcess } from '../../src/shared/child-process/run-process'
import { test, expect } from './helpers/orca-app'
import { attachRepoAndOpenTerminal } from './helpers/orca-restart'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_READY_MARKER
} from './helpers/golden-stub-agent'
import { resolveActiveTabId } from './helpers/terminal'

test.use({ seedTestRepo: false, launchEnv: getGoldenStubAgentLaunchEnv() })

async function createDraftTestRepo(root: string): Promise<string> {
  const repoPath = path.join(root, 'draft-project')
  await mkdir(repoPath)
  await writeFile(path.join(repoPath, 'README.md'), '# Draft handoff fixture\n')
  for (const args of [
    ['init'],
    ['config', 'user.email', 'e2e@test.local'],
    ['config', 'user.name', 'E2E Test'],
    ['add', 'README.md'],
    ['commit', '-m', 'Seed draft handoff fixture']
  ]) {
    const result = await runProcess({ program: 'git', args, cwd: repoPath })
    expect(result.code, result.stderr).toBe(0)
  }
  return repoPath
}

async function readActiveTabOutput(page: Page): Promise<string> {
  const tabId = await resolveActiveTabId(page)
  return page.evaluate((id) => {
    if (!id) {
      return ''
    }
    return (
      window.__paneManagers
        ?.get(id)
        ?.getPanes()
        .map((pane) => pane.serializeAddon.serialize())
        .join('\n') ?? ''
    )
  }, tabId)
}

test('retains a committed sending attempt interrupted before input without replaying @headful', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(120_000)
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orca-draft-interruption-')))
  registerPostElectronShutdownCleanup(() => rm(root, { recursive: true, force: true }))
  const repoPath = await createDraftTestRepo(root)
  await orcaPage.evaluate(
    async (workspaceDir) => {
      await window.__store!.getState().updateSettings({
        workspaceDir,
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: false
      })
    },
    path.join(root, 'workspaces')
  )
  await attachRepoAndOpenTerminal(orcaPage, repoPath)
  await configureGoldenStubAgent(orcaPage)
  const creation = await orcaPage.evaluateHandle(() => {
    const store = window.__store!
    const original = store.getState().createWorktree
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    store.setState({
      createWorktree: async (...args) => {
        await ready
        return original(...args)
      }
    })
    return {
      release: () => {
        store.setState({ createWorktree: original })
        release()
      }
    }
  })
  // Hold readiness after the durable sending commit; reload must not retry this ambiguous attempt.
  const interruption = await electronApp.evaluateHandle(({ ipcMain }) => {
    type Handler = (
      event: Electron.IpcMainInvokeEvent,
      args: { method: string; params?: { enter?: boolean } }
    ) => Promise<unknown>
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const original = handlers.get('runtime:call')
    if (!original) {
      throw new Error('Runtime IPC handler missing')
    }
    let writes = 0
    let waits = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('runtime:call')
    ipcMain.handle('runtime:call', async (event, args) => {
      if (args.method === 'terminal.send') {
        writes++
      }
      if (args.method === 'terminal.wait') {
        waits++
        await gate
      }
      return original(event, args)
    })
    return {
      state: () => ({ writes, waits }),
      restore: () => {
        ipcMain.removeHandler('runtime:call')
        ipcMain.handle('runtime:call', original)
        release()
      }
    }
  })
  const name = 'draft-interruption-proof'
  const prompt = 'Preserve this exact interrupted prompt.'
  const editor = orcaPage.getByRole('textbox', { name: 'Workspace prompt draft', exact: true })
  try {
    await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await dialog.getByPlaceholder(/Type a name/i).fill(name)
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    await expect(editor).toBeVisible()
    await editor.fill(prompt)
    await creation.evaluate((gate) => gate.release())
    await expect
      .poll(() => readActiveTabOutput(orcaPage), { timeout: 30_000 })
      .toContain(GOLDEN_STUB_READY_MARKER)
    await expect(orcaPage.getByText('Saved on this device', { exact: true })).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Send', exact: true }).click()
    await expect
      .poll(() => interruption.evaluate((gate) => gate.state().waits), { timeout: 15_000 })
      .toBe(1)
    await expect(orcaPage.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled()
    const writes = await interruption.evaluate((gate) => gate.state().writes)
    expect(writes).toBe(0)
    await orcaPage.reload()
    await orcaPage.getByRole('button', { name: /^Saved drafts \(1\)$/ }).click()
    await orcaPage.getByRole('menuitem', { name, exact: true }).click()
    await expect(editor).toHaveValue(prompt)
    await expect(
      orcaPage.getByText(
        'Delivery is unconfirmed. Check the terminal before sending again. Your draft is kept here.',
        { exact: true }
      )
    ).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await expect(orcaPage.getByRole('button', { name: 'Copy draft', exact: true })).toBeEnabled()
    await orcaPage.screenshot({ path: testInfo.outputPath('draft-interrupted-reloaded.png') })
    expect(await interruption.evaluate((gate) => gate.state())).toEqual({ writes, waits: 1 })
  } finally {
    await creation.evaluate((gate) => gate.release()).catch(() => undefined)
    await creation.dispose()
    await interruption.evaluate((gate) => gate.restore())
    await interruption.dispose()
  }
})
