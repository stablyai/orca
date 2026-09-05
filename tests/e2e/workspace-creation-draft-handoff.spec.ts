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
import { resolveActiveTabId, waitForPaneCount } from './helpers/terminal'

test.use({ seedTestRepo: false, launchEnv: getGoldenStubAgentLaunchEnv() })

async function createDraftTestRepo(root: string): Promise<string> {
  const repoPath = path.join(root, 'draft-project')
  await mkdir(repoPath)
  await writeFile(path.join(repoPath, 'README.md'), '# Draft handoff fixture\n')
  await writeFile(path.join(repoPath, 'orca.yaml'), 'scripts:\n  setup: echo SETUP_COMPLETE\n')
  for (const args of [
    ['init'],
    ['config', 'user.email', 'e2e@test.local'],
    ['config', 'user.name', 'E2E Test'],
    ['add', 'README.md', 'orca.yaml'],
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

test('keeps a draft editable through real checkout and setup split, then reloads it @headful', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(120_000)
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orca-draft-handoff-')))
  registerPostElectronShutdownCleanup(() => rm(root, { recursive: true, force: true }))
  const repoPath = await createDraftTestRepo(root)
  await orcaPage.evaluate(
    async (workspaceDir) => {
      await window.__store!.getState().updateSettings({
        workspaceDir,
        setupScriptLaunchMode: 'split-vertical',
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: false
      })
    },
    path.join(root, 'workspaces')
  )
  const parentId = await attachRepoAndOpenTerminal(orcaPage, repoPath)
  await configureGoldenStubAgent(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    const repo = state.repos[0]
    await state.updateRepo(repo.id, {
      hookSettings: {
        mode: 'auto',
        setupRunPolicy: 'run-by-default',
        setupAgentStartupPolicy: 'wait-for-setup',
        scripts: { setup: 'echo SETUP_COMPLETE', archive: '' },
        commandSourcePolicy: 'local-only'
      }
    })
  })

  // Hold only the request boundary; release executes the original Git/PTY creation flow.
  const gate = await orcaPage.evaluateHandle(() => {
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
  const name = 'draft-handoff-proof'
  const prompt = 'Keep this unsent prompt through setup.'
  const editor = orcaPage.getByRole('textbox', { name: 'Workspace prompt draft', exact: true })
  try {
    await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await dialog.getByPlaceholder(/Type a name/i).fill(name)
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()
    await orcaPage.keyboard.type(prompt)
    await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(7, 7))
    const originalEditor = await editor.elementHandle()
    expect(originalEditor).not.toBeNull()
    expect(
      await orcaPage.evaluate(() => window.__store!.getState().activePendingCreationId)
    ).toBeTruthy()

    await gate.evaluate((held) => held.release())
    await expect(
      orcaPage.locator('[role="option"][aria-current="page"]').filter({ hasText: name })
    ).toBeVisible({ timeout: 30_000 })
    const child = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      return Object.values(state.worktreesByRepo)
        .flat()
        .find((item) => item.id === state.activeWorktreeId)
    })
    expect(child?.id).not.toBe(parentId)
    if (!child) {
      throw new Error('Created workspace missing')
    }
    const git = await runProcess({
      program: 'git',
      args: ['rev-parse', '--is-inside-work-tree'],
      cwd: child.path
    })
    expect(git.stdout.trim()).toBe('true')
    await waitForPaneCount(orcaPage, 2, 30_000)
    await expect
      .poll(() => readActiveTabOutput(orcaPage), { timeout: 30_000 })
      .toContain(GOLDEN_STUB_READY_MARKER)
    await expect.poll(() => readActiveTabOutput(orcaPage)).toContain('SETUP_COMPLETE')
    expect(await editor.evaluate((node, previous) => node === previous, originalEditor)).toBe(true)
    await expect(editor).toBeFocused()
    expect(
      await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])
    ).toEqual([7, 7])
    await orcaPage.keyboard.type('X')
    const edited = `${prompt.slice(0, 7)}X${prompt.slice(7)}`
    await expect(editor).toHaveValue(edited)
    expect(await readActiveTabOutput(orcaPage)).not.toContain('GOLDEN_STUB_AGENT_SUBMITTED')
    await expect(orcaPage.getByText('Saved on this device', { exact: true })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('draft-setup-handoff.png') })

    await orcaPage.reload()
    await orcaPage.getByRole('button', { name: /^Saved drafts \(1\)$/ }).click()
    await orcaPage.getByRole('menuitem', { name, exact: true }).click()
    await expect(editor).toHaveValue(edited)
    await expect(editor).toBeFocused()
    await orcaPage.screenshot({ path: testInfo.outputPath('draft-reloaded.png') })
    await originalEditor?.dispose()
  } finally {
    await gate.evaluate((held) => held.release()).catch(() => undefined)
    await gate.dispose()
  }
})
