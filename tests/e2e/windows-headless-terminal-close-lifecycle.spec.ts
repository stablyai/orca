import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import type { RuntimeClient } from '../../src/cli/runtime/client'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalClose,
  RuntimeTerminalCreate,
  RuntimeTerminalListResult,
  RuntimeTerminalRead
} from '../../src/shared/runtime-types'

const execFileAsync = promisify(execFile)
const CHILD_PID_PREFIX = 'STA4903_CHILD_PID='

type WindowsProcessEvidence = {
  pid: number
  parentPid: number
  name: string
  handleCount: number | null
}

async function queryWindowsAncestry(pid: number): Promise<WindowsProcessEvidence[]> {
  const script = [
    `$targetPid = ${pid}`,
    '$rows = Get-CimInstance Win32_Process',
    '$byPid = @{}',
    'foreach ($row in $rows) { $byPid[[int]$row.ProcessId] = $row }',
    '$result = @()',
    'while ($byPid.ContainsKey($targetPid) -and $result.Count -lt 3) {',
    '  $row = $byPid[$targetPid]',
    '  $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue',
    '  $result += [pscustomobject]@{ pid = [int]$row.ProcessId; parentPid = [int]$row.ParentProcessId; name = [string]$row.Name; handleCount = if ($process) { [int]$process.HandleCount } else { $null } }',
    '  if ([int]$row.ParentProcessId -eq 0) { break }',
    '  $targetPid = [int]$row.ParentProcessId',
    '}',
    '$result | ConvertTo-Json -Compress'
  ].join('; ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 }
  )
  const parsed = JSON.parse(stdout.trim() || '[]') as
    | WindowsProcessEvidence
    | WindowsProcessEvidence[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function terminalParentTabIds(result: RuntimeMobileSessionTabsResult): string[] {
  return result.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.parentTabId] : []))
}

async function readChildPid(client: RuntimeClient, handle: string): Promise<number | null> {
  const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
    terminal: handle
  })
  const marker = read.result.terminal.tail.find((line) => line.includes(CHILD_PID_PREFIX))
  const value = marker?.slice(marker.indexOf(CHILD_PID_PREFIX) + CHILD_PID_PREFIX.length).trim()
  const pid = Number.parseInt(value ?? '', 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

test.describe.configure({ mode: 'serial' })

test('physical Windows exit wins the headless-tab close race', async ({ testRepoPath }) => {
  test.skip(process.platform !== 'win32', 'Physical Windows PTY lifecycle coverage')
  test.setTimeout(120_000)
  const host = await launchHeadlessPairedRuntimeHost()

  try {
    const client = host.client
    const added = await client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    let worktreeId = ''
    await expect
      .poll(
        async () => {
          const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          worktreeId = listed.result.worktrees[0]?.id ?? ''
          return worktreeId
        },
        { message: 'Headless host did not publish the physical test worktree' }
      )
      .not.toBe('')
    const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
      worktree: `id:${worktreeId}`,
      title: 'STA-4903 physical close race',
      command: `node -e "console.log('${CHILD_PID_PREFIX}' + process.pid); setInterval(() => {}, 1000)"`,
      presentation: 'background'
    })
    const terminal = created.result.terminal

    let childPid: number | null = null
    await expect
      .poll(
        async () => {
          childPid = await readChildPid(client, terminal.handle)
          return childPid
        },
        { message: 'Background PTY did not publish its physical Windows child PID' }
      )
      .not.toBeNull()
    const processBefore = await queryWindowsAncestry(childPid!)
    expect(processBefore).toMatchObject([
      { pid: childPid, name: 'node.exe' },
      { name: expect.stringMatching(/^(?:pwsh|powershell)\.exe$/i) },
      { name: 'electron.exe' }
    ])
    const ptyShellPid = processBefore[1]!.pid
    const windowCountBefore = await host.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    )
    const hostTabsBefore = await client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree: `id:${worktreeId}`
    })
    const inventoryBefore = await client.call<RuntimeTerminalListResult>('terminal.list', {
      worktree: `id:${worktreeId}`
    })
    expect(windowCountBefore).toBe(0)
    expect(terminalParentTabIds(hostTabsBefore.result)).toEqual([terminal.tabId])
    expect(inventoryBefore.result.terminals).toContainEqual(
      expect.objectContaining({ handle: terminal.handle, connected: true, writable: true })
    )

    const closeStartedAt = performance.now()
    let close: RuntimeTerminalClose | null = null
    let closeError: string | null = null
    try {
      close = (
        await client.call<{ close: RuntimeTerminalClose }>('terminal.close', {
          terminal: terminal.handle
        })
      ).result.close
    } catch (error) {
      closeError = error instanceof Error ? error.message : String(error)
    }
    const closeElapsedMs = performance.now() - closeStartedAt
    expect(closeError).toBeNull()

    await expect
      .poll(() => isProcessAlive(childPid!), { message: 'Windows child survived close' })
      .toBe(false)
    await expect
      .poll(() => isProcessAlive(ptyShellPid), { message: 'Windows PTY shell survived close' })
      .toBe(false)
    await expect
      .poll(
        async () => {
          const inventory = (
            await client.call<RuntimeTerminalListResult>('terminal.list', {
              worktree: `id:${worktreeId}`
            })
          ).result
          return inventory.terminals.length
        },
        { message: 'Closed terminal remained in the authoritative runtime inventory' }
      )
      .toBe(0)
    const inventoryAfter = (
      await client.call<RuntimeTerminalListResult>('terminal.list', {
        worktree: `id:${worktreeId}`
      })
    ).result
    const hostTabsAfter = await client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree: `id:${worktreeId}`
    })

    console.log(
      `[sta4903] ${JSON.stringify({ terminal, processBefore, windowCountBefore, hostTabIdsBefore: terminalParentTabIds(hostTabsBefore.result), close, closeError, closeElapsedMs, processAliveAfter: { child: isProcessAlive(childPid!), ptyShell: isProcessAlive(ptyShellPid) }, hostTabIdsAfter: terminalParentTabIds(hostTabsAfter.result), inventoryHandlesAfter: inventoryAfter.terminals.map((entry) => entry.handle) })}`
    )

    expect(close).toMatchObject({ handle: terminal.handle, tabId: terminal.tabId })
    expect(terminalParentTabIds(hostTabsAfter.result)).toEqual([])
  } finally {
    await host.dispose()
  }
})
