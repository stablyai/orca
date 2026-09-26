import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  getActiveWorktreeContext,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import { pressShortcut } from './helpers/shortcuts'
import { waitForSessionReady } from './helpers/store'
import { resolveActiveTabId, expectTerminalAccessibilityText } from './helpers/terminal'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  copyFileIntoDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  writeDockerSshRelayTargetFile
} from './helpers/docker-ssh-relay-target'
import {
  buildShellCommandFromArgv,
  resolveStartupShell
} from '../../src/shared/tui-agent-startup-shell'

const marker = 'ORCA_REVIEW_NOTE_DELIVERED'
const fixtureScript = path.join(process.cwd(), 'tests', 'tools', 'repro-terminal-send-submit.mjs')

for (const host of ['local', 'ssh'] as const) {
  for (const workspace of ['git', 'folder'] as const) {
    test(`${host} ${workspace} review notes reach the agent and clear after delivery`, async ({
      orcaPage,
      electronApp,
      registerPostElectronShutdownCleanup
    }, testInfo) => {
      test.skip(
        host === 'ssh' && process.env.ORCA_E2E_SSH_DOCKER !== '1',
        'Requires the Docker SSH fixture'
      )
      test.setTimeout(180_000)
      await waitForSessionReady(orcaPage)
      const localRoot = await mkdtemp(path.join(os.tmpdir(), 'orca-review-delivery-'))
      registerPostElectronShutdownCleanup(() => rm(localRoot, { recursive: true, force: true }))
      let context = await getActiveWorktreeContext(orcaPage)
      let scriptPath = fixtureScript
      let reportPath = path.join(localRoot, 'report.json')
      let nodePath = process.execPath
      let readReport = async (): Promise<unknown> => JSON.parse(await readFile(reportPath, 'utf8'))
      const content = 'This selected paragraph must arrive at the agent.\n'

      if (host === 'ssh') {
        const target = startDockerSshRelayTarget(testInfo)
        registerPostElectronShutdownCleanup(async () => cleanupDockerSshRelayTarget(target))
        const remoteRoot =
          workspace === 'git' ? DOCKER_SSH_RELAY_REMOTE_REPO_PATH : '/tmp/orca-review-folder'
        execDockerSshRelayTargetCommand(target, `mkdir -p ${shellQuote(remoteRoot)}`)
        scriptPath = '/tmp/orca-review-agent.mjs'
        reportPath = '/tmp/orca-review-report.json'
        nodePath = 'node'
        copyFileIntoDockerSshRelayTarget(target, fixtureScript, scriptPath)
        writeDockerSshRelayTargetFile(
          target,
          '/usr/local/bin/codex',
          `#!/bin/sh\nexec node ${shellQuote(scriptPath)} "$@"\n`
        )
        execDockerSshRelayTargetCommand(target, 'chmod +x /usr/local/bin/codex')
        writeDockerSshRelayTargetFile(target, path.posix.join(remoteRoot, 'review.md'), content)
        const remote = await connectDockerSshRelayTarget(orcaPage, target, {
          remotePath: remoteRoot,
          kind: workspace
        })
        context = { worktreeId: remote.worktreeId, rootPath: remoteRoot }
        readReport = async () =>
          JSON.parse(execDockerSshRelayTargetCommand(target, `cat ${shellQuote(reportPath)}`))
      } else {
        if (workspace === 'folder') {
          context = await orcaPage.evaluate(async (rootPath) => {
            const store = window.__store!
            const repo = await store.getState().addNonGitFolder(rootPath)
            if (!repo) {
              throw new Error('Folder fixture was not added')
            }
            const worktree = store.getState().worktreesByRepo[repo.id]?.[0]
            if (!worktree) {
              throw new Error('Folder workspace was not created')
            }
            store.getState().setActiveWorktree(worktree.id)
            return { worktreeId: worktree.id, rootPath: worktree.path }
          }, localRoot)
        }
        await writeFile(path.join(context.rootPath, 'review.md'), content)
      }

      const shell = resolveStartupShell(host === 'ssh' ? 'linux' : process.platform)
      const command = buildShellCommandFromArgv(
        [
          nodePath,
          scriptPath,
          '--fake-agent',
          '--report',
          reportPath,
          '--marker',
          marker,
          '--timeout-ms',
          '90000',
          '--composer-render-ms',
          '1',
          '--announce-paste-ready',
          ...(host === 'local' && process.platform === 'win32' ? ['--allow-unframed-paste'] : [])
        ],
        shell
      )
      const filePath = (host === 'ssh' ? path.posix : path).join(context.rootPath, 'review.md')
      await orcaPage.evaluate(
        async ({ command, worktreeId, filePath }) => {
          const state = window.__store!.getState()
          await state.updateSettings({
            uiLanguage: 'en',
            terminalWindowsShell: 'powershell.exe',
            agentCmdOverrides: { codex: command },
            agentDefaultArgs: { codex: '' }
          })
          await state.setKeybindingOverride('sourceControl.sendReviewNotes', ['Mod+Shift+Enter'])
          state.openFile({
            worktreeId,
            filePath,
            relativePath: 'review.md',
            language: 'markdown',
            mode: 'edit'
          })
        },
        { command, worktreeId: context.worktreeId, filePath }
      )
      const editor = await waitForRichMarkdownEditor(orcaPage)
      await editor.click()
      await pressShortcut(orcaPage, 'KeyA')
      await pressShortcut(orcaPage, 'KeyA', { shift: true })
      const draft = orcaPage.locator('.orca-diff-comment-popover textarea')
      await draft.fill(marker)
      await orcaPage.keyboard.press('Enter')
      await expect(draft).toHaveCount(0)
      await expect(orcaPage.getByText(marker, { exact: true }).first()).toBeVisible()
      await editor.click()
      await pressShortcut(orcaPage, 'Enter', { shift: true })
      await orcaPage.getByRole('menuitem', { name: /^Codex(?:\s|$)/ }).click()

      await expect
        .poll(
          async () => {
            try {
              return await readReport()
            } catch {
              return null
            }
          },
          { timeout: 60_000, message: 'The execution host never acknowledged the submitted note' }
        )
        .not.toBeNull()
      const report = await readReport()
      await testInfo.attach('agent-delivery', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json'
      })
      expect(report).toMatchObject({
        submitted: true,
        contractOk: true,
        prematureEnters: 0,
        markerReceived: true,
        cwd: host === 'ssh' ? context.rootPath : await realpath(context.rootPath),
        receivedInput: expect.stringContaining(marker)
      })
      expect(report).toMatchObject({
        receivedInput: expect.stringContaining('review.md')
      })
      const tabId = await resolveActiveTabId(orcaPage)
      if (!tabId) {
        throw new Error('Agent terminal was not opened')
      }
      await expectTerminalAccessibilityText(orcaPage, tabId, 'ORCA_TERMINAL_SEND_REPORT ok')
      await expect(orcaPage.getByRole('button', { name: 'More note actions' })).toHaveCount(0)
      await orcaPage.screenshot({ path: testInfo.outputPath(`${host}-${workspace}-delivered.png`) })
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible())
        )
      ).toBe(true)
    })
  }
}
