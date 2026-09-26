import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { mirrorWebRuntimeTabMove } from '@/components/tab-bar/web-runtime-tab-move-mirror'
import {
  canRunNativeChatSplitTarget,
  resolveActiveNativeChatSplitTarget,
  runNativeChatSplitTarget
} from './native-chat-layout-actions'

vi.mock('@/components/tab-bar/web-runtime-tab-move-mirror', () => ({
  mirrorWebRuntimeTabMove: vi.fn()
}))

function stateWithActiveTab(tab: Record<string, unknown>, tabOrder = ['chat', 'other']) {
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
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it.each(['right', 'down'] as const)(
    'moves a structured chat %s and mirrors its workspace',
    (direction) => {
      const dropUnifiedTab = vi.fn(() => true)
      vi.spyOn(useAppStore, 'getState').mockReturnValue({
        ...useAppStore.getState(),
        ...stateWithActiveTab({ contentType: 'agent-session' }),
        dropUnifiedTab
      })

      expect(
        runNativeChatSplitTarget(
          { kind: 'workspace-tab', unifiedTabId: 'chat', groupId: 'group' },
          direction
        )
      ).toBe(true)
      expect(dropUnifiedTab).toHaveBeenCalledWith('chat', {
        groupId: 'group',
        splitDirection: direction
      })
      expect(mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
        kind: 'split',
        worktreeId: 'workspace',
        tabId: 'chat',
        targetGroupId: 'group',
        splitDirection: direction
      })
    }
  )

  it('rejects a stale structured-chat group without moving or mirroring', () => {
    const dropUnifiedTab = vi.fn(() => true)
    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      ...useAppStore.getState(),
      ...stateWithActiveTab({ contentType: 'agent-session' }),
      dropUnifiedTab
    })

    expect(
      runNativeChatSplitTarget(
        { kind: 'workspace-tab', unifiedTabId: 'chat', groupId: 'old-group' },
        'right'
      )
    ).toBe(false)
    expect(dropUnifiedTab).not.toHaveBeenCalled()
    expect(mirrorWebRuntimeTabMove).not.toHaveBeenCalled()
  })

  it('resolves structured chats to the reusable workspace-tab move path', () => {
    const state = stateWithActiveTab({ contentType: 'agent-session' })
    const target = resolveActiveNativeChatSplitTarget(state, 'workspace', 'group')

    expect(target).toEqual({ kind: 'workspace-tab', unifiedTabId: 'chat', groupId: 'group' })
    expect(canRunNativeChatSplitTarget(state, target)).toBe(true)
    expect(
      canRunNativeChatSplitTarget(
        stateWithActiveTab({ contentType: 'agent-session' }, ['chat']),
        target
      )
    ).toBe(false)
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
