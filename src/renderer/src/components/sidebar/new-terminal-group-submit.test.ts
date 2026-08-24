// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealWorktree: mocks.activateAndRevealWorktree }
})

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal }
})

import { resolveTerminalGroupName, submitTerminalGroupCreate } from './new-terminal-group-submit'

const repo = {
  id: 'repo-1',
  displayName: 'orca',
  path: '/workspace/repo',
  connectionId: null
}

const createdWorktree = {
  id: 'repo-1::/workspace/repo::workspace:11111111-1111-4111-8111-111111111111',
  repoId: 'repo-1',
  path: '/workspace/repo'
} as Worktree

beforeEach(() => {
  mocks.activateAndRevealWorktree.mockReset().mockReturnValue({ primaryTabId: 'tab-1' })
  mocks.ensureAgentStartupInTerminal.mockReset()
  ;(window as unknown as { api: Record<string, unknown> }).api = {}
})

describe('resolveTerminalGroupName', () => {
  it('falls back to a project-derived label instead of an empty card', () => {
    expect(resolveTerminalGroupName('  servers ', 'orca')).toBe('servers')
    expect(resolveTerminalGroupName('   ', 'orca')).toBe('orca terminals')
  })
})

describe('submitTerminalGroupCreate', () => {
  it('creates the group and reveals it without an agent startup', async () => {
    const createTerminalGroup = vi.fn().mockResolvedValue(createdWorktree)

    const created = await submitTerminalGroupCreate({
      repo,
      name: 'servers',
      agent: null,
      platform: 'darwin',
      createTerminalGroup,
      onOpenChange: vi.fn()
    })

    expect(created).toBe(true)
    expect(createTerminalGroup).toHaveBeenCalledWith({ repoId: 'repo-1', name: 'servers' })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(createdWorktree.id, {})
  })

  it('launches the selected agent in the new group', async () => {
    const createTerminalGroup = vi.fn().mockResolvedValue(createdWorktree)

    await submitTerminalGroupCreate({
      repo,
      name: 'research',
      agent: 'codex',
      platform: 'darwin',
      createTerminalGroup,
      onOpenChange: vi.fn()
    })

    const [, options] = mocks.activateAndRevealWorktree.mock.calls[0]
    expect(options.startup).toMatchObject({
      launchAgent: 'codex',
      telemetry: expect.objectContaining({ launch_source: 'sidebar', request_kind: 'new' })
    })
    expect(options.startup.command).toContain('codex')
  })

  it('keeps the dialog open when creation returns nothing', async () => {
    const onOpenChange = vi.fn()

    const created = await submitTerminalGroupCreate({
      repo,
      name: 'servers',
      agent: null,
      platform: 'darwin',
      createTerminalGroup: vi.fn().mockResolvedValue(null),
      onOpenChange
    })

    expect(created).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
