// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { spawnIpcPty } from './ipc-pty-spawn-request'
import type { IpcPtyTransportOptions } from './pty-transport-types'

const REPO_ROOT = join(import.meta.dirname, '../../../../..')

type SpawnMock = ReturnType<typeof vi.fn>

function installSpawn(): SpawnMock {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
  ;(globalThis as unknown as { window: { api: { pty: { spawn: SpawnMock } } } }).window = {
    api: { pty: { spawn } }
  }
  return spawn
}

function seedTab(worktreeId: string, tab: { id: string; incognito?: boolean }): void {
  useAppStore.setState({ tabsByWorktree: { [worktreeId]: [tab] } } as never)
}

const connectOptions = { cols: 80, rows: 24 } as unknown as Parameters<typeof spawnIpcPty>[1]

describe('spawnIpcPty incognito on the renderer-backed (foreground desktop) path', () => {
  let spawn: SpawnMock

  beforeEach(() => {
    spawn = installSpawn()
    useAppStore.setState({ tabsByWorktree: {} } as never)
  })
  afterEach(() => {
    useAppStore.setState({ tabsByWorktree: {} } as never)
  })

  it('threads incognito=true to the daemon spawn when the stamped tab is incognito', async () => {
    seedTab('wt', { id: 'tab-1', incognito: true })
    await spawnIpcPty(
      { worktreeId: 'wt', tabId: 'tab-1' } as IpcPtyTransportOptions,
      connectOptions
    )
    expect(spawn.mock.calls[0][0]).toMatchObject({ incognito: true })
  })

  it('does NOT thread incognito for a normal (recording) tab', async () => {
    seedTab('wt', { id: 'tab-1' })
    await spawnIpcPty(
      { worktreeId: 'wt', tabId: 'tab-1' } as IpcPtyTransportOptions,
      connectOptions
    )
    expect(spawn.mock.calls[0][0].incognito).toBeUndefined()
  })

  it('honors an explicit transportOptions.incognito override', async () => {
    await spawnIpcPty(
      { worktreeId: 'wt', tabId: 'absent', incognito: true } as IpcPtyTransportOptions,
      connectOptions
    )
    expect(spawn.mock.calls[0][0]).toMatchObject({ incognito: true })
  })
})

describe('createDesktopTerminal resolves and sends incognito (regression guard)', () => {
  it('resolves incognito and includes it in the renderer tab-create request', () => {
    // Source guard: the foreground/renderer-backed create path must resolve incognito and send it,
    // or UI-launched incognito terminals record on the daemon (the B-foreground leak).
    const source = readFileSync(
      join(REPO_ROOT, 'src/main/runtime/orca-runtime-create-terminal-desktop.ts'),
      'utf8'
    )
    expect(source).toContain('resolveTerminalIncognito(')
    expect(source).toContain('incognito ? { incognito: true }')
  })
})
