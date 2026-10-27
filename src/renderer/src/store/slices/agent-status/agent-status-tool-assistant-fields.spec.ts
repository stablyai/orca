import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status-freshness'
import type { AppState } from '../../types'
import { createTestStore } from '../store-test-helpers'

export function registerAgentStatusToolAssistantFieldsTests(): void {
  describe('agent status tool + assistant fields', () => {
    // Fake timers prevent queueMicrotask’s real 30-minute freshness handles keeping Vitest alive.
    afterEach(() => {
      vi.useRealTimers()
    })

    it('writes toolName, toolInput, and assistant preview provenance straight onto the entry', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.getState().setAgentStatus('tab-1:1', {
        state: 'working',
        prompt: 'Edit the config',
        agentType: 'claude',
        toolName: 'Edit',
        toolInput: '/src/config.ts',
        lastAssistantMessage: 'Edited config.ts',
        lastAssistantMessageIsToolOutput: true
      })
      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry.toolName).toBe('Edit')
      expect(entry.toolInput).toBe('/src/config.ts')
      expect(entry.lastAssistantMessage).toBe('Edited config.ts')
      expect(entry.lastAssistantMessageIsToolOutput).toBe(true)
    })

    it('clears fields to undefined when a later payload omits them', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.getState().setAgentStatus('tab-1:1', {
        state: 'working',
        prompt: 'Edit the config',
        agentType: 'claude',
        toolName: 'Edit',
        toolInput: '/src/config.ts',
        lastAssistantMessage: 'Edited config.ts',
        lastAssistantMessageIsToolOutput: true
      })
      // Main owns tool/assistant fields; undefined on a fresh turn must clear rather than inherit prior values.
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'Next step', agentType: 'claude' })
      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry.toolName).toBeUndefined()
      expect(entry.toolInput).toBeUndefined()
      expect(entry.lastAssistantMessage).toBeUndefined()
      expect(entry.lastAssistantMessageIsToolOutput).toBeUndefined()
    })

    it('preserves prior agentType when payload omits it', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'claude' })
      store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2' })
      expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
    })

    it('preserves prior agentType when payload sends the "unknown" sentinel', () => {
      // Unknown means no identity evidence; retain known agents instead of flickering labels/icons on weak pings.
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'claude' })
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'unknown' })
      expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
    })

    it('preserves the active pane row when a nested hook sends a different known value', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'codex' })
      const before = store.getState().agentStatusByPaneKey['tab-1:1']
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'claude' })
      expect(store.getState().agentStatusByPaneKey['tab-1:1']).toBe(before)
    })

    it('ignores nested done while the parent pane agent is still active', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      const setGeneratedTabTitleFromAgentPrompt = vi.fn()
      store.setState({
        settings: { ...store.getState().settings, tabAutoGenerateTitle: true },
        setGeneratedTabTitleFromAgentPrompt
      } as Partial<AppState>)
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'parent codex', agentType: 'codex' },
          'codex',
          { updatedAt: 1_000, stateStartedAt: 1_000 }
        )
      const firstEpoch = store.getState().agentStatusEpoch

      store.getState().setAgentStatus(
        'tab-1:1',
        {
          state: 'done',
          prompt: 'nested claude',
          agentType: 'claude',
          toolName: 'Read',
          toolInput: '00-review-context.md',
          lastAssistantMessage: 'child finished'
        },
        'claude',
        { updatedAt: 1_100, stateStartedAt: 1_100 }
      )

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry).toMatchObject({
        state: 'working',
        prompt: 'parent codex',
        agentType: 'codex',
        updatedAt: 1_000,
        stateStartedAt: 1_000
      })
      expect(entry.toolName).toBeUndefined()
      expect(entry.toolInput).toBeUndefined()
      expect(entry.lastAssistantMessage).toBeUndefined()
      expect(store.getState().agentStatusEpoch).toBe(firstEpoch)
      expect(setGeneratedTabTitleFromAgentPrompt).toHaveBeenCalledTimes(1)
      expect(setGeneratedTabTitleFromAgentPrompt).toHaveBeenLastCalledWith(
        'tab-1:1',
        'parent codex'
      )
    })

    it('does not let restored-unconfirmed identity suppress a live terminal status', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.getState().setAgentStatus(
        'tab-1:1',
        {
          state: 'working',
          prompt: 'stale codex turn',
          agentType: 'codex',
          restoredUnconfirmed: true
        },
        'codex',
        { updatedAt: 1_000, stateStartedAt: 1_000 }
      )

      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'done', prompt: 'live claude turn', agentType: 'claude' },
          'claude',
          { updatedAt: 1_100, stateStartedAt: 1_100 }
        )

      expect(store.getState().agentStatusByPaneKey['tab-1:1']).toMatchObject({
        state: 'done',
        prompt: 'live claude turn',
        agentType: 'claude'
      })
      expect(store.getState().agentStatusByPaneKey['tab-1:1'].restoredUnconfirmed).toBeUndefined()
    })

    it('allows pane agentType to change after the prior turn is done', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'done', prompt: 'p1', agentType: 'codex' })
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'claude' })
      expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
    })

    it('allows stale active pane agentType to change', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'p1', agentType: 'codex' },
          'codex',
          {
            updatedAt: 1_000,
            stateStartedAt: 1_000
          }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'p2', agentType: 'claude' },
          'claude',
          {
            updatedAt: 1_000 + AGENT_STATUS_STALE_AFTER_MS + 1,
            stateStartedAt: 1_000 + AGENT_STATUS_STALE_AFTER_MS + 1
          }
        )
      expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
    })

    it('keeps global epochs stable for fresh same-state working pings while updating the entry', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'p1', agentType: 'claude', toolName: 'Read' },
          'claude',
          { updatedAt: 1_000, stateStartedAt: 1_000 }
        )
      const firstEpoch = store.getState().agentStatusEpoch
      const firstSortEpoch = store.getState().sortEpoch

      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'p2', agentType: 'claude', toolName: 'Edit' },
          'claude',
          { updatedAt: 2_000, stateStartedAt: 1_000 }
        )

      const sameStateEntry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(sameStateEntry.prompt).toBe('p2')
      expect(sameStateEntry.toolName).toBe('Edit')
      expect(sameStateEntry.updatedAt).toBe(2_000)
      // High-frequency same-state content updates stay row-local; global epochs mark state/freshness/final-done aggregate changes.
      expect(store.getState().agentStatusEpoch).toBe(firstEpoch)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch)

      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'done', prompt: 'p2', agentType: 'claude' }, 'claude', {
          updatedAt: 3_000,
          stateStartedAt: 3_000
        })
      expect(store.getState().agentStatusEpoch).toBe(firstEpoch + 1)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
    })

    it('bumps aggregate epochs when a same-state entry gains worktree attribution', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p' }, 'claude', {
        updatedAt: 1_000,
        stateStartedAt: 1_000
      })
      const firstEpoch = store.getState().agentStatusEpoch
      const firstSortEpoch = store.getState().sortEpoch

      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'p' },
          'claude',
          { updatedAt: 2_000, stateStartedAt: 1_000 },
          { worktreeId: 'wt-1', tabId: 'tab-1' }
        )

      expect(store.getState().agentStatusEpoch).toBe(firstEpoch + 1)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
    })

    it('bumps the status epoch when same-state working enters monitoring', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p' }, 'claude', {
        updatedAt: 1_000,
        stateStartedAt: 1_000
      })
      const firstEpoch = store.getState().agentStatusEpoch
      const firstSortEpoch = store.getState().sortEpoch

      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', workingMode: 'monitoring', prompt: 'p' },
          'claude',
          { updatedAt: 2_000, stateStartedAt: 1_000 }
        )

      expect(store.getState().agentStatusByPaneKey['tab-1:1'].workingMode).toBe('monitoring')
      expect(store.getState().agentStatusEpoch).toBe(firstEpoch + 1)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch)
    })

    it('bumps the status epoch, not sort epoch, for same-state done updates', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'done', prompt: 'p1', agentType: 'claude' }, 'claude', {
          updatedAt: 1_000,
          stateStartedAt: 1_000
        })
      const firstEpoch = store.getState().agentStatusEpoch
      const firstSortEpoch = store.getState().sortEpoch

      store.getState().setAgentStatus(
        'tab-1:1',
        {
          state: 'done',
          prompt: 'p1',
          agentType: 'claude',
          lastAssistantMessage: 'final answer'
        },
        'claude',
        { updatedAt: 1_000, stateStartedAt: 1_000 }
      )

      expect(store.getState().agentStatusByPaneKey['tab-1:1'].lastAssistantMessage).toBe(
        'final answer'
      )
      // done→done refreshes retention snapshot without changing sort class; tick only status epoch.
      expect(store.getState().agentStatusEpoch).toBe(firstEpoch + 1)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch)
    })

    it('bumps sort epoch when a same-state done update changes completion eligibility', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'done', prompt: 'p1', agentType: 'claude', interrupted: true },
          'claude',
          { updatedAt: 1_000, stateStartedAt: 1_000 }
        )
      const firstSortEpoch = store.getState().sortEpoch

      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'done', prompt: 'p1', agentType: 'claude' }, 'claude', {
          updatedAt: 2_000,
          stateStartedAt: 1_000
        })

      expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
    })

    it('bumps global epochs when a stale same-state entry refreshes', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'stale ping', agentType: 'claude' },
          'claude',
          { updatedAt: 1_000, stateStartedAt: 1_000 }
        )
      const firstEpoch = store.getState().agentStatusEpoch
      const firstSortEpoch = store.getState().sortEpoch

      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'fresh again', agentType: 'claude' },
          'claude',
          {
            updatedAt: 1_000 + AGENT_STATUS_STALE_AFTER_MS + 1,
            stateStartedAt: 1_000
          }
        )

      const refreshedEntry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(refreshedEntry.prompt).toBe('fresh again')
      // Stale refresh can restore attention sort class; tick freshness and sort epochs.
      expect(store.getState().agentStatusEpoch).toBe(firstEpoch + 1)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
    })

    it('bumps sort epoch when Command Code starts a new prompt while still working', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'first task', agentType: 'command-code' },
          'command-code',
          { updatedAt: 1_000, stateStartedAt: 1_000 }
        )
      const firstSortEpoch = store.getState().sortEpoch

      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'second task', agentType: 'command-code' },
          'command-code',
          { updatedAt: 2_000, stateStartedAt: 2_000 }
        )

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry.prompt).toBe('second task')
      expect(entry.stateStartedAt).toBe(2_000)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
    })

    it('bumps sort epoch when Command Code reruns the same prompt with a new turn key', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.getState().setAgentStatus(
        'tab-1:1',
        {
          state: 'working',
          prompt: 'same task',
          agentType: 'command-code',
          promptInteractionKey: 'command-code-transcript-a'
        },
        'command-code',
        { updatedAt: 1_000, stateStartedAt: 1_000 }
      )
      const firstSortEpoch = store.getState().sortEpoch

      store.getState().setAgentStatus(
        'tab-1:1',
        {
          state: 'working',
          prompt: 'same task',
          agentType: 'command-code',
          promptInteractionKey: 'command-code-transcript-b'
        },
        'command-code',
        { updatedAt: 2_000, stateStartedAt: 2_000 }
      )

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry.prompt).toBe('same task')
      expect(entry.promptInteractionKey).toBe('command-code-transcript-b')
      expect(entry.stateStartedAt).toBe(2_000)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
    })

    it('bumps sort epoch when main advances Command Code stateStartedAt without a renderer-visible key change', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      // First turn carries no interaction key (e.g. transcript read failed), so
      // the renderer stores no promptInteractionKey to compare against.
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'same task', agentType: 'command-code' },
          'command-code',
          { updatedAt: 1_000, stateStartedAt: 1_000 }
        )
      const firstSortEpoch = store.getState().sortEpoch

      // Absent interaction key masks same-prompt new turns; authoritative stateStartedAt advance must still resort.
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'same task', agentType: 'command-code' },
          'command-code',
          { updatedAt: 2_000, stateStartedAt: 2_000 }
        )

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry.stateStartedAt).toBe(2_000)
      expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
    })
  })
}
