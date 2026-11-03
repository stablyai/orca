import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeCommand = vi.hoisted(() => vi.fn())
const state: { plugins: unknown[]; off: string[]; workspace: string | null } = vi.hoisted(() => ({
  plugins: [],
  off: [],
  workspace: 'wt-1'
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { pluginReplacementsOff: state.off },
      activeWorktreeId: state.workspace
    })
  }
}))
vi.mock('@/store/plugin-panels', () => ({
  usePluginPanelsStore: { getState: () => ({ plugins: state.plugins }) },
  collectActivePluginCommands: (
    plugins: { pluginKey: string; name: string; commands: object[] }[]
  ) =>
    plugins.flatMap((plugin) =>
      plugin.commands.map((command) => ({
        ...command,
        pluginKey: plugin.pluginKey,
        pluginName: plugin.name
      }))
    )
}))

import {
  PLUGIN_REPLACEMENT_TIMEOUT_MS,
  runBuiltInOrReplacement
} from './plugin-command-replacements'

const command = (extra: Record<string, unknown> = {}) => ({
  id: 'tasks',
  title: 'Tasks',
  context: 'global',
  handler: { type: 'worker' },
  keybindings: [],
  replaces: 'view.tasks',
  ...extra
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  invokeCommand.mockReset()
  vi.stubGlobal('window', { api: { plugins: { invokeCommand } } })
  state.plugins = [
    { pluginKey: 'acme.tasks', name: 'Tasks plus', status: 'idle', commands: [command()] }
  ]
  state.off = []
  state.workspace = 'wt-1'
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a built-in action a plugin replaces', () => {
  it("runs Orca's own after 2 s of silence, and only once", async () => {
    const builtIn = vi.fn()
    let answer: (value: unknown) => void = () => {}
    invokeCommand.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    runBuiltInOrReplacement('view.tasks', builtIn)
    await vi.advanceTimersByTimeAsync(PLUGIN_REPLACEMENT_TIMEOUT_MS - 1)
    expect(builtIn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(builtIn).toHaveBeenCalledTimes(1)
    answer('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(builtIn).toHaveBeenCalledTimes(1)
  })
})
