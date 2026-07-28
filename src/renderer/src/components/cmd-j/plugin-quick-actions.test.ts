import { describe, expect, it, vi } from 'vitest'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { buildPluginQuickActions } from './plugin-quick-actions'

vi.mock('@/lib/plugin-command-execution', () => ({ executePluginCommand: vi.fn() }))

function command(context: 'global' | 'worktree'): ActivePluginCommand {
  return {
    pluginKey: 'orca-samples.tasks',
    pluginName: 'Tasks Pack',
    id: 'open',
    title: 'Open Tasks',
    context,
    handler: { type: 'built-in', action: 'view.tasks' },
    keybindings: []
  }
}

describe('plugin Cmd+J actions', () => {
  it('adds enabled plugin commands with plugin attribution', () => {
    const action = buildPluginQuickActions([command('global')])[0]!

    expect(action).toMatchObject({
      id: 'plugin:orca-samples.tasks/open',
      title: 'Open Tasks',
      description: 'Tasks Pack plugin command'
    })
    expect(action.isAvailable({ activeWorktreeId: null } as never)).toEqual({ available: true })
  })

  it('requires an active workspace for worktree commands', () => {
    const action = buildPluginQuickActions([command('worktree')])[0]!

    expect(action.isAvailable({ activeWorktreeId: null } as never)).toEqual({
      available: false,
      reason: 'no-active-workspace'
    })
    expect(action.isAvailable({ activeWorktreeId: 'worktree-1' } as never)).toEqual({
      available: true
    })
  })
})
