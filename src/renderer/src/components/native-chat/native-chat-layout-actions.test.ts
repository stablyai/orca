import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  canRunNativeChatSplitTarget,
  resolveActiveNativeChatSplitTarget
} from './native-chat-layout-actions'

function stateWithActiveTab(tab: Record<string, unknown>, tabOrder = ['chat']) {
  return {
    groupsByWorktree: {
      workspace: [{ id: 'group', worktreeId: 'workspace', activeTabId: 'chat', tabOrder }]
    },
    unifiedTabsByWorktree: {
      workspace: [
        {
          id: 'chat',
          entityId: 'session',
          groupId: 'group',
          worktreeId: 'workspace',
          ...tab
        }
      ]
    }
  } as unknown as Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>
}

describe('native chat layout actions', () => {
  it('can split a structured chat even when it is the only tab', () => {
    const state = stateWithActiveTab({ contentType: 'agent-session', agentSessionAgent: 'codex' })
    const target = resolveActiveNativeChatSplitTarget(state, 'workspace', 'group')

    expect(target).toEqual({ kind: 'workspace-tab', unifiedTabId: 'chat', groupId: 'group' })
    expect(canRunNativeChatSplitTarget(state, target)).toBe(true)
  })

  it('resolves terminal-backed chat mode to the existing pane split path', () => {
    const state = stateWithActiveTab({ contentType: 'terminal', viewMode: 'chat' })

    expect(resolveActiveNativeChatSplitTarget(state, 'workspace', 'group')).toEqual({
      kind: 'terminal-pane',
      terminalTabId: 'session'
    })
    expect(
      resolveActiveNativeChatSplitTarget(
        stateWithActiveTab({ contentType: 'terminal', viewMode: 'terminal' }),
        'workspace',
        'group'
      )
    ).toBeNull()
  })
})
