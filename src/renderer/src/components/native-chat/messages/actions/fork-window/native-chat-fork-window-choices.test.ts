import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import {
  defaultNativeChatForkAgent,
  nativeChatForkHostChoices,
  nativeChatForkRecapMessages,
  nativeChatForkRoute
} from './native-chat-fork-window-choices'

const IMPORT = 'ai-vault.chat-fork-import.v1'
const hosts = [
  { id: 'local' as const, label: 'This computer', capabilities: ['x'] },
  { id: 'runtime:new' as const, label: 'Studio', capabilities: [IMPORT] },
  { id: 'runtime:old' as const, label: 'Laptop', capabilities: [] },
  { id: 'runtime:off' as const, label: 'Server', capabilities: null }
]

function message(id: string, role: 'user' | 'assistant'): NativeChatMessage {
  return { id, role, blocks: [], timestamp: null, source: 'transcript' }
}

describe('defaultNativeChatForkAgent', () => {
  it('keeps the same agent unless it is out of usage', () => {
    expect(
      defaultNativeChatForkAgent({
        sourceAgent: 'claude',
        usageLimited: false,
        available: ['claude', 'codex']
      })
    ).toBe('claude')
  })

  it('picks an agent that does not share the limit when out of usage', () => {
    expect(
      defaultNativeChatForkAgent({
        sourceAgent: 'claude',
        usageLimited: true,
        available: ['claude', 'claude-agent-teams', 'codex', 'gemini'],
        preferred: 'gemini'
      })
    ).toBe('gemini')
    expect(
      defaultNativeChatForkAgent({
        sourceAgent: 'claude',
        usageLimited: true,
        available: ['claude-agent-teams', 'codex']
      })
    ).toBe('codex')
  })
})

describe('nativeChatForkHostChoices', () => {
  it('offers only importing hosts for an exact copy, others disabled with a reason', () => {
    expect(
      nativeChatForkHostChoices({
        sourceHostId: 'local',
        hosts,
        copiesHistory: true,
        sourceCanExport: true,
        importCapability: IMPORT
      })
    ).toEqual([
      { id: 'local', label: 'This computer', disabled: false },
      { id: 'runtime:new', label: 'Studio', disabled: false },
      { id: 'runtime:old', label: 'Laptop', disabled: true, blocked: 'needs-update' },
      { id: 'runtime:off', label: 'Server', disabled: true, blocked: 'offline' }
    ])
  })

  it('keeps an exact copy on its host when the source cannot export', () => {
    expect(
      nativeChatForkHostChoices({
        sourceHostId: 'runtime:new',
        hosts,
        copiesHistory: true,
        sourceCanExport: false,
        importCapability: IMPORT
      })
    ).toEqual([{ id: 'runtime:new', label: 'Studio', disabled: false }])
  })

  it('lets a recap go to any connected host', () => {
    const choices = nativeChatForkHostChoices({
      sourceHostId: 'local',
      hosts,
      copiesHistory: false,
      sourceCanExport: false,
      importCapability: IMPORT
    })
    expect(choices.filter((choice) => !choice.disabled).map((choice) => choice.id)).toEqual([
      'local',
      'runtime:new',
      'runtime:old'
    ])
  })
})

describe('nativeChatForkRoute', () => {
  it('copies on the host, copies across hosts, or recaps for another agent', () => {
    const base = { sourceHostId: 'local' as const, sourceAgent: 'claude' as const }
    expect(nativeChatForkRoute({ ...base, hostId: 'local', agent: 'claude' })).toBe('same')
    expect(nativeChatForkRoute({ ...base, hostId: 'runtime:new', agent: 'claude' })).toBe(
      'other-host'
    )
    expect(nativeChatForkRoute({ ...base, hostId: 'runtime:new', agent: 'codex' })).toBe('recap')
  })
})

describe('nativeChatForkRecapMessages', () => {
  it('cuts after the fork point, keeping the rest of its turn', () => {
    const messages = [
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('a1-tools', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant')
    ]
    expect(nativeChatForkRecapMessages(messages, 'a1')?.map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
      'a1-tools'
    ])
    expect(nativeChatForkRecapMessages(messages, 'missing')).toBeNull()
  })
})
