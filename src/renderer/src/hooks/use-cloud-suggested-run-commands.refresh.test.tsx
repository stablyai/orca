// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type State = {
  ephemeralVmRuntimesByWorkspaceId: Record<string, { status: string }>
  wakingEphemeralVmWorkspaceIds: Record<string, boolean>
}

const mocks = vi.hoisted(() => {
  const state: State = {
    ephemeralVmRuntimesByWorkspaceId: { ws: { status: 'running' } },
    wakingEphemeralVmWorkspaceIds: {}
  }
  return {
    read: vi.fn<() => Promise<{ content: string; isBinary: boolean }>>(),
    sleepIntent: false,
    now: 1_000_000,
    state
  }
})
vi.mock('@/store', () => ({
  useAppStore: (select: (state: State) => unknown) => select(mocks.state)
}))
vi.mock('@/store/github/refresh/worktree-refresh', () => ({
  findWorktreeById: () => ({ path: '/vercel/orca/workspaces/app/ws' })
}))
vi.mock('@/runtime/files/reads/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.read
}))
vi.mock('@/lib/worktree-sleep-intent', () => ({
  hasWorktreeSleepIntent: () => mocks.sleepIntent
}))

const { useCloudSuggestedRunCommands, resetSuggestionRefreshThrottleForTest } =
  await import('./use-cloud-suggested-run-commands')

const HOST = { hostId: 'runtime:env' as const, label: 'Orca Cloud', environmentId: 'env' }
let latest: ReturnType<typeof useCloudSuggestedRunCommands> = { commands: [], refresh: () => {} }
function Probe(): null {
  latest = useCloudSuggestedRunCommands('ws', HOST)
  return null
}

const flush = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 0)))
const labels = (): string[] => latest.commands.map((entry) => entry.command.label)
const pkg = (scripts: Record<string, string>) => ({
  content: JSON.stringify({ scripts }),
  isBinary: false
})

describe('Run menu suggestions refresh (LC2-P3)', () => {
  let root: Root
  beforeEach(() => {
    mocks.read.mockReset()
    mocks.sleepIntent = false
    mocks.now = 1_000_000
    mocks.state = {
      ephemeralVmRuntimesByWorkspaceId: { ws: { status: 'running' } },
      wakingEphemeralVmWorkspaceIds: {}
    }
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.now)
    resetSuggestionRefreshThrottleForTest()
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.restoreAllMocks()
  })

  it('a package.json created after mount shows up on the next refresh (menu open)', async () => {
    mocks.read.mockRejectedValueOnce(new Error('ENOENT: no such file'))
    await act(async () => root.render(createElement(Probe)))
    await flush()
    expect(labels()).toEqual([])

    mocks.read.mockResolvedValue(pkg({ test: 'vitest', lint: 'eslint .' }))
    mocks.now += 6_000
    await act(async () => latest.refresh())
    await flush()
    expect(labels()).toEqual(['test', 'lint'])
  })

  it('re-reads at most once per 5 s however often the menu opens or the pointer enters', async () => {
    mocks.read.mockResolvedValue(pkg({ test: 'vitest' }))
    await act(async () => root.render(createElement(Probe)))
    await flush()
    for (let i = 0; i < 5; i++) {
      mocks.now += 500
      await act(async () => latest.refresh())
      await act(async () => window.dispatchEvent(new Event('focus')))
    }
    await flush()
    expect(mocks.read).toHaveBeenCalledTimes(1)

    mocks.now += 5_000
    const first = latest.commands
    await act(async () => latest.refresh())
    await flush()
    expect(mocks.read).toHaveBeenCalledTimes(2)
    // Nothing changed: the same list, so the menu doesn't re-render.
    expect(latest.commands).toBe(first)
  })

  it('never reads from a sandbox that is asleep, going to sleep or waking', async () => {
    mocks.read.mockResolvedValue(pkg({ test: 'vitest' }))
    for (const setup of [
      () => (mocks.state.ephemeralVmRuntimesByWorkspaceId = { ws: { status: 'suspended' } }),
      () => (mocks.state.wakingEphemeralVmWorkspaceIds = { ws: true }),
      () => (mocks.sleepIntent = true)
    ]) {
      mocks.state = {
        ephemeralVmRuntimesByWorkspaceId: { ws: { status: 'running' } },
        wakingEphemeralVmWorkspaceIds: {}
      }
      mocks.sleepIntent = false
      setup()
      mocks.now += 10_000
      await act(async () => root.render(createElement(Probe)))
      await act(async () => latest.refresh())
      await act(async () => window.dispatchEvent(new Event('focus')))
      await flush()
    }
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
