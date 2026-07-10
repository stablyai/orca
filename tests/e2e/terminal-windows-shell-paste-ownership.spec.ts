import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { WINDOWS_GIT_BASH_SHELL } from '../../src/shared/windows-terminal-shell'
import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'

type WindowsPasteShell = 'cmd.exe' | 'powershell.exe' | 'wsl.exe' | typeof WINDOWS_GIT_BASH_SHELL

function hasWslNodeRuntime(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  try {
    execFileSync('wsl.exe', ['--', 'sh', '-lc', 'command -v node'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15_000
    })
    return true
  } catch {
    return false
  }
}

function toDefaultWslPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([A-Za-z]):\/?(.*)$/)
  if (!driveMatch) {
    throw new Error(`Cannot convert Windows path to default WSL path: ${windowsPath}`)
  }
  return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`
}

function pasteCollectScript(runId: string, sentinel: string, expectedText: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let received = ''
const interrupt = String.fromCharCode(3)
const bracketStart = String.fromCharCode(27) + '[200~'
const bracketEnd = String.fromCharCode(27) + '[201~'
const expectedText = ${JSON.stringify(expectedText)}
process.stdout.write('PASTE_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  received += chunk
  if (!received.includes(${JSON.stringify(sentinel)})) {
    return
  }
  const normalized = received.split(bracketStart).join('').split(bracketEnd).join('')
  const status = normalized === expectedText
    ? 'MATCH'
    : 'MISMATCH:' + normalized.length + ':' + expectedText.length
  process.stdout.write('PASTE_COMPLETE_${runId}:' + status + '\\n')
})
`
}

function countOccurrences(value: string, needle: string): number {
  let count = 0
  let index = value.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = value.indexOf(needle, index + needle.length)
  }
  return count
}

async function createWindowsDefaultShellTerminalTab(
  page: Page,
  shell: WindowsPasteShell
): Promise<string> {
  const tabId = await page.evaluate(async (selectedShell) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }

    await state.updateSettings({ terminalWindowsShell: selectedShell })
    const terminal = store.getState().createTab(worktreeId)
    store.getState().setActiveTab(terminal.id)
    store.getState().setActiveTabType('terminal')
    return terminal.id
  }, shell)

  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await expect(tab).toBeVisible()
  await expect(tab.locator('[data-shell-icon]')).toHaveAttribute('data-shell-icon', shell)

  return tabId
}

async function configureActiveProjectWslRuntime(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const [wslDistro] = await window.api.wsl.listDistros()
    if (!wslDistro) {
      return null
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }
    const activeWorktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === worktreeId)
    const activeProject = state.projects.find((project) =>
      activeWorktree ? project.sourceRepoIds.includes(activeWorktree.repoId) : false
    )
    if (!activeProject) {
      throw new Error('No active project')
    }

    // Why: WSL is selected through project/runtime preferences now; the global
    // Windows default shell setting only represents host shells.
    await state.updateProject(activeProject.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: wslDistro }
    })
    return wslDistro
  })
}

async function createWindowsProjectRuntimeTerminalTab(
  page: Page,
  shell: WindowsPasteShell
): Promise<string> {
  const tabId = await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }

    const terminal = store.getState().createTab(worktreeId)
    store.getState().setActiveTab(terminal.id)
    store.getState().setActiveTabType('terminal')
    return terminal.id
  })

  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await expect(tab).toBeVisible()
  await expect(tab.locator('[data-shell-icon]')).toHaveAttribute('data-shell-icon', shell)

  return tabId
}

async function updateWindowsDefaultShellSetting(
  page: Page,
  shell: WindowsPasteShell
): Promise<void> {
  await page.evaluate(async (selectedShell) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await store.getState().updateSettings({ terminalWindowsShell: selectedShell })
  }, shell)
}

test.describe('Windows terminal shell paste ownership', () => {
  async function skipWhenGitBashUnavailable(page: Page): Promise<void> {
    const isAvailable = await page.evaluate(() => window.api.gitBash.isAvailable())
    test.skip(!isAvailable, 'Git Bash is not available on this Windows host')
  }

  test('PowerShell default terminal keyboard paste preserves exact content with one PTY owner', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    test.skip(process.platform !== 'win32', 'PowerShell paste coverage is Windows-only')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await createWindowsDefaultShellTerminalTab(orcaPage, 'powershell.exe')
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const sentinel = `ORCA_E2E_POWERSHELL_DONE_${runId}`
    const powershellEscape = '`'
    const payload = [
      `ORCA_E2E_POWERSHELL_PASTE_${runId}`,
      `PowerShell metacharacters: ${powershellEscape} $ " ' ; | & < > @ { } ( )`,
      'quoted Windows path: C:\\Program Files\\Orca Test\\file name.txt',
      'cmd metacharacters preserved as text: %PATH% !PROMPT! ^ & | < >',
      'Unicode: café 你好 مرحبا 😀',
      `mixed-newline-before\r\nlf-line\ncrlf-line\r\n${sentinel}`
    ].join('\n')
    const scriptPath = path.join(testRepoPath, `.orca-paste-powershell-shell-${runId}.mjs`)
    writeFileSync(scriptPath, pasteCollectScript(runId, sentinel, payload))
    let scriptStarted = false

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      scriptStarted = true
      await waitForTerminalOutput(orcaPage, `PASTE_READY_${runId}`, 10_000)

      await clearTerminalPtyWriteLog(electronApp)
      await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await focusActiveTerminalInput(orcaPage)

      await orcaPage.keyboard.press('Control+V')
      await waitForTerminalOutput(orcaPage, `PASTE_COMPLETE_${runId}:MATCH`, 10_000, 12_000)

      const writes = (await readTerminalPtyWrites(electronApp)).join('')
      expect(countOccurrences(writes, payload), 'PowerShell payload PTY write count').toBe(1)
    } finally {
      if (scriptStarted) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })

  test('cmd.exe default terminal keyboard paste preserves exact content with one PTY owner', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    test.skip(process.platform !== 'win32', 'cmd.exe paste coverage is Windows-only')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await createWindowsDefaultShellTerminalTab(orcaPage, 'cmd.exe')
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const sentinel = `ORCA_E2E_CMD_DONE_${runId}`
    const payload = [
      `ORCA_E2E_CMD_PASTE_${runId}`,
      'cmd metacharacters: %PATH% !PROMPT! ^ & | < >',
      'quoted Windows path: C:\\Program Files\\Orca Test\\file name.txt',
      'PowerShell metacharacters: ` $ " \' ; @ { } ( )',
      `mixed-newline-before\r\nlf-line\ncrlf-line\r\n${sentinel}`
    ].join('\n')
    const scriptPath = path.join(testRepoPath, `.orca-paste-cmd-shell-${runId}.mjs`)
    writeFileSync(scriptPath, pasteCollectScript(runId, sentinel, payload))
    let scriptStarted = false

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      scriptStarted = true
      await waitForTerminalOutput(orcaPage, `PASTE_READY_${runId}`, 10_000)

      await clearTerminalPtyWriteLog(electronApp)
      await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await focusActiveTerminalInput(orcaPage)

      await orcaPage.keyboard.press('Control+V')
      await waitForTerminalOutput(orcaPage, `PASTE_COMPLETE_${runId}:MATCH`, 10_000, 12_000)

      const writes = (await readTerminalPtyWrites(electronApp)).join('')
      expect(countOccurrences(writes, payload), 'cmd.exe payload PTY write count').toBe(1)
    } finally {
      if (scriptStarted) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })

  test('Git Bash default terminal keyboard paste preserves POSIX-shaped content with one PTY owner', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    test.skip(process.platform !== 'win32', 'Git Bash paste coverage is Windows-only')
    await skipWhenGitBashUnavailable(orcaPage)

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await createWindowsDefaultShellTerminalTab(orcaPage, WINDOWS_GIT_BASH_SHELL)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const sentinel = `ORCA_E2E_GIT_BASH_DONE_${runId}`
    const payload = [
      `ORCA_E2E_GIT_BASH_PASTE_${runId}`,
      'POSIX shell metacharacters: $ ` " \' ; | & < > * ? [ ] ( )',
      'Windows path with spaces: C:\\Users\\Name\\My Project\\file.txt',
      'POSIX path with spaces: /home/user/my project/file.txt',
      `mixed-newline-before\r\nlf-line\ncrlf-line\r\n${sentinel}`
    ].join('\n')
    const scriptPath = path.join(testRepoPath, `.orca-paste-git-bash-shell-${runId}.mjs`)
    writeFileSync(scriptPath, pasteCollectScript(runId, sentinel, payload))
    let scriptStarted = false

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      scriptStarted = true
      await waitForTerminalOutput(orcaPage, `PASTE_READY_${runId}`, 10_000)

      await clearTerminalPtyWriteLog(electronApp)
      await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await focusActiveTerminalInput(orcaPage)

      await orcaPage.keyboard.press('Control+V')
      await waitForTerminalOutput(orcaPage, `PASTE_COMPLETE_${runId}:MATCH`, 10_000, 12_000)

      const writes = (await readTerminalPtyWrites(electronApp)).join('')
      expect(countOccurrences(writes, payload), 'Git Bash payload PTY write count').toBe(1)
    } finally {
      if (scriptStarted) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })

  test('WSL terminal keyboard paste preserves Linux shell content with one PTY owner', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    test.skip(process.platform !== 'win32', 'WSL paste coverage is Windows-only')
    test.skip(!hasWslNodeRuntime(), 'WSL with node is not available on this Windows host')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const wslDistro = await configureActiveProjectWslRuntime(orcaPage)
    test.skip(!wslDistro, 'No WSL distro is available on this Windows host')
    await createWindowsProjectRuntimeTerminalTab(orcaPage, 'wsl.exe')
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const sentinel = `ORCA_E2E_WSL_DONE_${runId}`
    const payload = [
      `ORCA_E2E_WSL_PASTE_${runId}`,
      'POSIX shell metacharacters: $ ` " \' ; | & < > * ? [ ] ( )',
      'Linux path with spaces: /home/user/my project/file.txt',
      'Windows path preserved as text: C:\\Users\\Name\\My Project\\file.txt',
      'Unicode: café 你好 مرحبا 😀',
      `mixed-newline-before\r\nlf-line\ncrlf-line\r\n${sentinel}`
    ].join('\n')
    const scriptPath = path.join(testRepoPath, `.orca-paste-wsl-shell-${runId}.mjs`)
    writeFileSync(scriptPath, pasteCollectScript(runId, sentinel, payload))
    let scriptStarted = false

    try {
      await sendToTerminal(
        orcaPage,
        ptyId,
        `node ${JSON.stringify(toDefaultWslPath(scriptPath))}\r`
      )
      scriptStarted = true
      await waitForTerminalOutput(orcaPage, `PASTE_READY_${runId}`, 10_000)

      await clearTerminalPtyWriteLog(electronApp)
      await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await focusActiveTerminalInput(orcaPage)

      await orcaPage.keyboard.press('Control+V')
      await waitForTerminalOutput(orcaPage, `PASTE_COMPLETE_${runId}:MATCH`, 10_000, 12_000)

      const writes = (await readTerminalPtyWrites(electronApp)).join('')
      expect(countOccurrences(writes, payload), 'WSL payload PTY write count').toBe(1)
    } finally {
      if (scriptStarted) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })

  test('existing WSL terminal keeps paste runtime after default shell changes', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    test.skip(process.platform !== 'win32', 'WSL paste runtime retention is Windows-only')
    test.skip(!hasWslNodeRuntime(), 'WSL with node is not available on this Windows host')

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const wslDistro = await configureActiveProjectWslRuntime(orcaPage)
    test.skip(!wslDistro, 'No WSL distro is available on this Windows host')
    const tabId = await createWindowsProjectRuntimeTerminalTab(orcaPage, 'wsl.exe')
    await updateWindowsDefaultShellSetting(orcaPage, 'cmd.exe')
    await expect(
      orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"] [data-shell-icon]`)
    ).toHaveAttribute('data-shell-icon', 'wsl.exe')
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const sentinel = `ORCA_E2E_WSL_RETENTION_DONE_${runId}`
    const payload = [
      `ORCA_E2E_WSL_RETENTION_PASTE_${runId}`,
      'Default shell changed to cmd.exe after this WSL PTY was created.',
      'POSIX path remains valid for the existing terminal: /home/user/my project/file.txt',
      'Windows path remains literal text: C:\\Users\\Name\\My Project\\file.txt',
      `mixed-newline-before\r\nlf-line\ncrlf-line\r\n${sentinel}`
    ].join('\n')
    const scriptPath = path.join(testRepoPath, `.orca-paste-wsl-retention-${runId}.mjs`)
    writeFileSync(scriptPath, pasteCollectScript(runId, sentinel, payload))
    let scriptStarted = false

    try {
      await sendToTerminal(
        orcaPage,
        ptyId,
        `node ${JSON.stringify(toDefaultWslPath(scriptPath))}\r`
      )
      scriptStarted = true
      await waitForTerminalOutput(orcaPage, `PASTE_READY_${runId}`, 10_000)

      await clearTerminalPtyWriteLog(electronApp)
      await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), payload)
      await focusActiveTerminalInput(orcaPage)

      await orcaPage.keyboard.press('Control+V')
      await waitForTerminalOutput(orcaPage, `PASTE_COMPLETE_${runId}:MATCH`, 10_000, 12_000)

      const writes = (await readTerminalPtyWrites(electronApp)).join('')
      expect(countOccurrences(writes, payload), 'retained WSL payload PTY write count').toBe(1)
    } finally {
      if (scriptStarted) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      rmSync(scriptPath, { force: true })
    }
  })
})
