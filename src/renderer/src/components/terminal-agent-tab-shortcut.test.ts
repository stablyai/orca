import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type * as UseAgentDetectionTarget from '@/hooks/useAgentDetectionTarget'
import { resolveTerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'

// getAgentDetectionTargetKeyForWorktree encodes the floating worktree id into
// 'local:<id>:host'; parseAgentDetectionTargetKey extracts the trailing segment as contextKey.
// It's not arbitrary: localPreflightContextKey(undefined) — what floating's own preflight
// context resolves to, since it "must not inherit any agent runtime fallback" — also
// literally returns 'host', so the two paths agree on the same real cache key.
const FLOATING_TARGET_KEY = `local:${encodeURIComponent(FLOATING_TERMINAL_WORKTREE_ID)}:host`
const FLOATING_LOCAL_CONTEXT_KEY = 'host'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  targetKeysByWorktreeId: {} as Record<string, string | undefined>,
  connectionId: undefined as string | null | undefined
}))

vi.mock('../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('../lib/connection-context', () => ({ getConnectionId: () => mocks.connectionId }))
vi.mock('@/hooks/useAgentDetectionTarget', async (importOriginal) => {
  const actual = await importOriginal<typeof UseAgentDetectionTarget>()
  return {
    ...actual,
    getAgentDetectionTargetKeyForWorktree: (
      _state: unknown,
      worktreeId: string | null
    ): string | undefined => (worktreeId ? mocks.targetKeysByWorktreeId[worktreeId] : undefined)
  }
})

function matchOnly(actionId: string) {
  return (candidate: string): boolean => candidate === actionId
}

describe('resolveTerminalAgentTabShortcut', () => {
  beforeEach(() => {
    mocks.targetKeysByWorktreeId = { [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TARGET_KEY }
    mocks.connectionId = undefined
    mocks.state = {
      settings: { defaultTuiAgent: 'claude', disabledTuiAgents: [] },
      detectedAgentIds: ['claude'],
      remoteDetectedAgentIds: {},
      localDetectedAgentIdsByContext: {},
      ensureDetectedAgents: vi.fn()
    }
  })

  it('returns null when no chord matches', () => {
    expect(
      resolveTerminalAgentTabShortcut({
        activeWorktreeId: 'wt-1',
        keybindings: {},
        matchShortcut: () => false
      })
    ).toEqual({ actionId: null, agent: null })
  })

  it('uses the active worktree connection for a local main-window launch', () => {
    expect(
      resolveTerminalAgentTabShortcut({
        activeWorktreeId: 'wt-1',
        keybindings: {},
        matchShortcut: matchOnly('tab.newAgent')
      })
    ).toEqual({ actionId: 'tab.newAgent', agent: 'claude' })
  })

  it('reads a remote detected-agent list when the active worktree is SSH-owned', () => {
    mocks.connectionId = 'ssh-conn'
    mocks.state.remoteDetectedAgentIds = { 'ssh-conn': ['codex'] }
    mocks.state.settings = { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
    expect(
      resolveTerminalAgentTabShortcut({
        activeWorktreeId: 'wt-1',
        keybindings: {},
        matchShortcut: matchOnly('tab.newAgent')
      })
    ).toEqual({ actionId: 'tab.newAgent', agent: 'codex' })
  })

  it('reads the floating workspace’s own detected-agent cache when it is already warm', () => {
    mocks.state.localDetectedAgentIdsByContext = { [FLOATING_LOCAL_CONTEXT_KEY]: ['codex'] }
    mocks.state.settings = { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
    const result = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt-1',
      floatingWorkspaceFocused: true,
      keybindings: {},
      matchShortcut: matchOnly('tab.newAgent')
    })
    expect(result).toEqual({ actionId: 'tab.newAgent', agent: 'codex' })
    expect(mocks.state.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('falls back to the general local list and warms the floating cache on a cold read', () => {
    // localDetectedAgentIdsByContext has no entry for the floating context yet.
    const result = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt-1',
      floatingWorkspaceFocused: true,
      keybindings: {},
      matchShortcut: matchOnly('tab.newAgent')
    })
    expect(result).toEqual({ actionId: 'tab.newAgent', agent: 'claude' })
    expect(mocks.state.ensureDetectedAgents).toHaveBeenCalledWith(FLOATING_TERMINAL_WORKTREE_ID)
  })

  it('retries detection on a null (previously-empty) floating cache entry too', () => {
    mocks.state.localDetectedAgentIdsByContext = { [FLOATING_LOCAL_CONTEXT_KEY]: null }
    resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt-1',
      floatingWorkspaceFocused: true,
      keybindings: {},
      matchShortcut: matchOnly('tab.newAgent')
    })
    expect(mocks.state.ensureDetectedAgents).toHaveBeenCalledWith(FLOATING_TERMINAL_WORKTREE_ID)
  })

  it('falls through to a bound per-agent chord when tab.newAgent does not match', () => {
    mocks.state.settings = { defaultTuiAgent: 'claude', disabledTuiAgents: [] }
    const result = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt-1',
      keybindings: { 'tab.newAgent.codex': ['Mod+Alt+Shift+X'] },
      matchShortcut: matchOnly('tab.newAgent.codex')
    })
    expect(result).toEqual({ actionId: 'tab.newAgent.codex', agent: 'codex' })
  })
})
