import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { copyPaneAgentSessionId, readPaneAgentSessionId } from './terminal-agent-session-id-copy'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function statusMap(entry: Partial<AgentStatusEntry>): Record<string, AgentStatusEntry> {
  return { [`tab-1:${LEAF_ID}`]: entry as AgentStatusEntry }
}

describe('readPaneAgentSessionId', () => {
  it('reads the provider session id reported for the pane', () => {
    const map = statusMap({ providerSession: { key: 'session_id', id: 'session-abc' } })
    expect(readPaneAgentSessionId(map, 'tab-1', LEAF_ID)).toBe('session-abc')
  })

  it('reads conversation-keyed ids the same way', () => {
    const map = statusMap({ providerSession: { key: 'conversation_id', id: 'conv-9' } })
    expect(readPaneAgentSessionId(map, 'tab-1', LEAF_ID)).toBe('conv-9')
  })

  it('returns null for panes with no agent, no session, or a blank id', () => {
    expect(readPaneAgentSessionId({}, 'tab-1', LEAF_ID)).toBeNull()
    expect(readPaneAgentSessionId(statusMap({}), 'tab-1', LEAF_ID)).toBeNull()
    expect(
      readPaneAgentSessionId(
        statusMap({ providerSession: { key: 'session_id', id: '  ' } }),
        'tab-1',
        LEAF_ID
      )
    ).toBeNull()
  })

  it('does not leak another tab’s session id for the same leaf', () => {
    const map = statusMap({ providerSession: { key: 'session_id', id: 'session-abc' } })
    expect(readPaneAgentSessionId(map, 'tab-2', LEAF_ID)).toBeNull()
  })
})

describe('copyPaneAgentSessionId', () => {
  it('copies the session id', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)

    await expect(
      copyPaneAgentSessionId({
        agentStatusByPaneKey: statusMap({
          providerSession: { key: 'session_id', id: 'session-abc' }
        }),
        tabId: 'tab-1',
        leafId: LEAF_ID,
        writeClipboardText
      })
    ).resolves.toBe('copied')
    expect(writeClipboardText).toHaveBeenCalledWith('session-abc')
  })

  it('reports an absent session without touching the clipboard', async () => {
    const writeClipboardText = vi.fn()

    await expect(
      copyPaneAgentSessionId({
        agentStatusByPaneKey: {},
        tabId: 'tab-1',
        leafId: LEAF_ID,
        writeClipboardText
      })
    ).resolves.toBe('unavailable')
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  // Why: writeClipboardText rejects on insecure web origins; success must not be claimed.
  it('reports a rejected clipboard write separately', async () => {
    await expect(
      copyPaneAgentSessionId({
        agentStatusByPaneKey: statusMap({
          providerSession: { key: 'session_id', id: 'session-abc' }
        }),
        tabId: 'tab-1',
        leafId: LEAF_ID,
        writeClipboardText: vi.fn().mockRejectedValue(new Error('denied'))
      })
    ).resolves.toBe('copy-failed')
  })
})
