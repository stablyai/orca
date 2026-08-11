// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { registerAppCommandDispatcher } from './app-command-dispatch'
import { executePluginCommand } from './plugin-command-execution'

let unregister: (() => void) | null = null

afterEach(() => {
  unregister?.()
  unregister = null
})

function command(handler: ActivePluginCommand['handler']): ActivePluginCommand {
  return {
    pluginKey: 'orca-samples.tasks',
    pluginName: 'Tasks',
    id: 'open',
    title: 'Open Tasks',
    context: 'global',
    handler,
    keybindings: []
  }
}

describe('plugin command execution', () => {
  it('dispatches aliases without invoking a plugin worker', async () => {
    const dispatcher = vi.fn(() => true)
    const invokeCommand = vi.fn()
    unregister = registerAppCommandDispatcher(dispatcher)
    Object.assign(window, { api: { plugins: { invokeCommand } } })

    await executePluginCommand(
      command({ type: 'built-in', action: 'view.tasks' }),
      'plugin-palette'
    )

    expect(dispatcher).toHaveBeenCalledWith('view.tasks', 'plugin-palette')
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('routes worker commands through the authenticated preload binding', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, { api: { plugins: { invokeCommand } } })

    await executePluginCommand(command({ type: 'worker' }), 'plugin-keybinding')

    expect(invokeCommand).toHaveBeenCalledWith({
      pluginKey: 'orca-samples.tasks',
      commandId: 'open'
    })
  })
})
