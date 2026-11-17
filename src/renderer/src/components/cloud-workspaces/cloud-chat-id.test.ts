import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  findCloudChatTarget,
  parseCloudChatId,
  type CloudChatTerminalLayout
} from './cloud-chat-id'

function tab(overrides: Partial<Tab>): Tab {
  return {
    id: 'tab-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

// Remote PTY ids carry their handle; local ones have none.
const handleOf = (ptyId: string): string | null =>
  ptyId.startsWith('remote:') ? ptyId.slice('remote:'.length) : null

describe('cloud chat ids', () => {
  it('parses session and terminal ids in the control-plane alphabet', () => {
    expect(parseCloudChatId('s:ses_123')).toEqual({ kind: 'session', id: 'ses_123' })
    expect(parseCloudChatId('t:term-9.a')).toEqual({ kind: 'terminal', id: 'term-9.a' })
  })

  it('decodes base64url ids with other characters', () => {
    expect(parseCloudChatId('tb:cGFuZS8yIOKckw')).toEqual({ kind: 'terminal', id: 'pane/2 ✓' })
  })

  it('rejects malformed chat ids', () => {
    for (const bad of ['', 'x:1', 's:', 'sb:***', 'tb:%%', `s:${'a'.repeat(200)}`]) {
      expect(parseCloudChatId(bad)).toBeNull()
    }
  })

  it('routes a chat id to the session tab or the terminal pane that shows it', () => {
    const terminal = tab({ id: 'tab-t', entityId: 'tab-t' })
    const session = tab({ id: 'tab-s', entityId: 'ses_7', contentType: 'agent-session' })
    const layouts: Record<string, CloudChatTerminalLayout> = {
      'tab-t': {
        activeLeafId: 'leaf-a',
        ptyIdsByLeafId: { 'leaf-a': 'remote:x', 'leaf-b': 'remote:y' }
      }
    }
    const layoutOf = (t: Tab) => layouts[t.entityId]
    expect(
      findCloudChatTarget({ kind: 'session', id: 'ses_7' }, [terminal, session], layoutOf, handleOf)
    ).toEqual({ kind: 'session', sessionId: 'ses_7' })
    expect(
      findCloudChatTarget({ kind: 'terminal', id: 'y' }, [terminal, session], layoutOf, handleOf)
    ).toEqual({ kind: 'terminal', tab: terminal, leafId: 'leaf-b' })
    expect(
      findCloudChatTarget({ kind: 'terminal', id: 'gone' }, [terminal], layoutOf, handleOf)
    ).toBeNull()
  })
})
