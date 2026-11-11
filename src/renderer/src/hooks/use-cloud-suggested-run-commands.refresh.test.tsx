// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn<() => Promise<{ content: string; isBinary: boolean }>>()
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({})
}))
vi.mock('@/store/github/refresh/worktree-refresh', () => ({
  findWorktreeById: () => ({ path: '/vercel/orca/workspaces/app/ws' })
}))
vi.mock('@/runtime/files/reads/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.read
}))

const { useCloudSuggestedRunCommands } = await import('./use-cloud-suggested-run-commands')

const HOST = { hostId: 'runtime:env' as const, label: 'Orca Cloud', environmentId: 'env' }
let latest: ReturnType<typeof useCloudSuggestedRunCommands> = { commands: [], refresh: () => {} }
function Probe(): null {
  latest = useCloudSuggestedRunCommands('ws', HOST)
  return null
}

const flush = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 0)))
const labels = (): string[] => latest.commands.map((entry) => entry.command.label)

describe('Run menu suggestions refresh (LC2-P3)', () => {
  let root: Root
  beforeEach(() => {
    mocks.read.mockReset()
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
  })

  it('a package.json created after mount shows up on the next refresh (menu open)', async () => {
    mocks.read.mockRejectedValueOnce(new Error('ENOENT: no such file'))
    await act(async () => root.render(createElement(Probe)))
    await flush()
    expect(labels()).toEqual([])

    mocks.read.mockResolvedValue({
      content: JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }),
      isBinary: false
    })
    await act(async () => latest.refresh())
    await flush()
    expect(labels()).toEqual(['test', 'lint'])
  })

  it('re-reads when the window regains focus, and keeps the same list when nothing changed', async () => {
    mocks.read.mockResolvedValue({
      content: JSON.stringify({ scripts: { test: 'vitest' } }),
      isBinary: false
    })
    await act(async () => root.render(createElement(Probe)))
    await flush()
    const first = latest.commands
    expect(labels()).toEqual(['test'])

    await act(async () => window.dispatchEvent(new Event('focus')))
    await flush()
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(latest.commands).toBe(first)
  })
})
