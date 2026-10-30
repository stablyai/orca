import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'

const store: { current: ReturnType<typeof createTestStore> | null } = vi.hoisted(() => ({
  current: null
}))

vi.mock('../store', () => ({
  useAppStore: { getState: () => store.current!.getState(), subscribe: () => () => {} }
}))

import { resolveTerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
import { agentMenuShortcutLabels } from './tab-bar/agent-menu-shortcut-labels'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../shared/keybindings'
import * as inventory from '@/lib/agent-detection-target-inventory'

// A paired server’s SSH workspace lists agents under that server, not under its client-unknown SSH connection.
describe('resolveTerminalAgentTabShortcut', () => {
  it("picks the default agent from a paired server's SSH workspace inventory", () => {
    store.current = createTestStore()
    store.current.setState({
      repos: [
        { ...TEST_REPO, connectionId: 'server-ssh-target', executionHostId: 'runtime:env-1' }
      ],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })] },
      runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('env-1', 'wt-1')]: ['claude'] }
    })

    const shortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt-1',
      keybindings: {},
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })

    expect(shortcut).toEqual({ actionId: 'tab.newAgent', agent: 'claude' })
  })

  // Why (#29599): before the tab bar's probe lands, the shortcut must ask the paired server.
  it("waits for a paired server's agent list instead of reporting no agent", async () => {
    store.current = createTestStore()
    const ensureRuntimeDetectedAgents = vi.fn(async () => {
      const key = getRuntimeAgentInventoryKey('env-1', 'wt-1')
      store.current!.setState({ runtimeDetectedAgentIds: { [key]: ['claude'] } })
      return ['claude' as const]
    })
    const ensureDetectedAgents = vi.fn(async () => [])
    store.current.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:env-1' }],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })] },
      settings: { ...store.current.getState().settings!, defaultTuiAgent: 'claude' },
      ensureRuntimeDetectedAgents,
      ensureDetectedAgents
    })

    const shortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt-1',
      keybindings: {},
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })

    expect(shortcut.actionId).toBe('tab.newAgent')
    await expect(shortcut.pendingAgent).resolves.toBe('claude')
    expect(ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'wt-1')
    expect(ensureDetectedAgents).not.toHaveBeenCalled()
  })
})

describe('effective agent menu shortcuts', () => {
  beforeEach(() => {
    store.current = createTestStore()
    store.current.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id })] },
      detectedAgentIds: ['claude', 'codex'],
      settings: {
        ...store.current.getState().settings!,
        defaultTuiAgent: 'blank',
        experimentalNativeChat: false
      }
    })
  })
  const labels = (keys: KeybindingOverrides, platform: NodeJS.Platform = 'darwin') =>
    agentMenuShortcutLabels('wt', keys, platform)

  it.each(['darwin', 'win32', 'linux'] as const)(
    'shows fallback and distinct keys once on %s',
    (platform) => {
      const keys: KeybindingOverrides = {
        'tab.newAgent': ['Mod+Alt+T'],
        'tab.newAgent.claude': ['Mod+Shift+C', 'Mod+Alt+T'],
        'tab.newAgent.codex': ['Mod+Shift+C', 'Mod+Shift+X']
      }
      const result = labels(keys, platform)
      expect(result.get('claude')).toBe(platform === 'darwin' ? '⌘⌥T, ⌘⇧C' : 'Ctrl+Alt+T, Ctrl+⇧+C')
      expect(result.get('codex')).toBe(platform === 'darwin' ? '⌘⇧X' : 'Ctrl+⇧+X')
    }
  )

  it.each([
    {
      earlier: 'Mod+Plus',
      own: 'Mod+NumpadAdd',
      key: '+',
      code: 'NumpadAdd',
      altKey: false,
      visible: false
    },
    {
      earlier: 'Mod+Alt+BracketLeft',
      own: 'Ctrl+Alt+BracketLeft',
      key: '[',
      code: 'BracketLeft',
      altKey: true,
      visible: false
    }
  ])('projects matcher overlap rather than conflict-identity equality: $own', (test) => {
    const keys: KeybindingOverrides = {
      'tab.newTerminal': [test.earlier],
      'tab.newAgent.codex': [test.own]
    }
    const input = { key: test.key, code: test.code, ctrlKey: true, altKey: test.altKey }
    const resolved = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt',
      keybindings: keys,
      includeTerminal: true,
      matchShortcut: (id) => keybindingMatchesAction(id, input, 'linux', keys)
    })
    expect(resolved.actionId).toBe(test.visible ? 'tab.newAgent.codex' : 'tab.newTerminal')
    expect(labels(keys, 'linux').has('codex')).toBe(test.visible)
    expect(
      resolveTerminalAgentTabShortcut({
        activeWorktreeId: 'wt',
        keybindings: keys,
        matchShortcut: (id) => id === 'tab.newTerminal'
      })
    ).toEqual({ actionId: null, agent: null })
  })

  it('does not label a chord that a main-process window shortcut claims first', () => {
    const result = labels({
      'tab.newAgent': [],
      'tab.newAgent.codex': ['Mod+Equal'],
      'tab.newAgent.claude': ['Mod+Shift+C']
    })
    expect([...result]).toEqual([['claude', '⌘⇧C']])
  })

  it('keeps explicit keys when inventory is unknown without acquiring and hides disabled keys', () => {
    const acquire = vi.fn()
    store.current!.setState({
      detectedAgentIds: null,
      ensureDetectedAgents: acquire,
      settings: { ...store.current!.getState().settings!, disabledTuiAgents: ['claude'] }
    })
    const result = labels({
      'tab.newAgent.codex': ['Mod+Shift+X'],
      'tab.newAgent.claude': ['Mod+Shift+C']
    })
    expect([...result]).toEqual([['codex', '⌘⇧X']])
    expect(acquire).not.toHaveBeenCalled()
  })

  it('does not repeat target reads as unrelated workspace records grow', () => {
    const reads = vi.spyOn(inventory, 'readDetectedAgentsForWorktree')
    const counts = [10, 100].map((count) => {
      store.current!.setState({
        worktreesByRepo: {
          [TEST_REPO.id]: [
            makeWorktree({ id: 'wt', repoId: TEST_REPO.id }),
            ...Array.from({ length: count }, (_, index) =>
              makeWorktree({ id: `other-${index}`, repoId: TEST_REPO.id })
            )
          ]
        }
      })
      reads.mockClear()
      labels({ 'tab.newAgent.codex': ['Mod+Shift+X'] })
      return reads.mock.calls.length
    })
    expect(counts).toEqual([1, 1])
    reads.mockRestore()
  })
})
