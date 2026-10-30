import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import {
  structuredChatTabById,
  structuredChatTabBySessionId,
  structuredChatWorkspacesBySessionId,
  chatWorkspaceByTabId
} from './structured-chat-tab-index'

function tab(id: string, contentType: Tab['contentType'] = 'agent-session'): Tab {
  return {
    id,
    entityId: `session-${id}`,
    contentType,
    groupId: 'group',
    worktreeId: 'workspace',
    label: 'Chat name',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('structured chat tab index', () => {
  it('indexes an immutable snapshot once across rows and lookup kinds', () => {
    let reads = 0
    const structured = tab('chat')
    const tabs = new Proxy([tab('terminal', 'terminal'), structured], {
      get: (target, property) => {
        if (property === '0' || property === '1') {
          reads += 1
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- The test proxy counts array reads without changing iteration.
        return Reflect.get(target, property)
      }
    })
    expect(structuredChatTabById({ workspace: tabs }, 'workspace', 'chat')).toBe(structured)
    const initialReads = reads
    expect(initialReads).toBeGreaterThan(0)
    expect(structuredChatTabBySessionId({ workspace: tabs }, 'workspace', 'session-chat')).toBe(
      structured
    )
    expect(structuredChatTabById({ workspace: tabs }, 'workspace', 'terminal')).toBeUndefined()
    expect(structuredChatTabById({ workspace: tabs }, 'workspace', 'missing')).toBeUndefined()
    expect(reads).toBe(initialReads)
    const renamed = { ...structured, customLabel: 'Manual name' }
    expect(
      structuredChatTabBySessionId({ workspace: [renamed] }, 'workspace', 'session-chat')
    ).toBe(renamed)
    expect(structuredChatTabById(undefined, 'workspace', 'chat')).toBeUndefined()
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'finds nothing for a workspace id named after an object member (%s)',
    (workspaceId) => {
      const tabsByWorkspace: Record<string, readonly Tab[]> = { workspace: [tab('chat')] }
      expect(structuredChatTabBySessionId(tabsByWorkspace, workspaceId, 'session-chat')).toBe(
        undefined
      )
      expect(structuredChatTabById(tabsByWorkspace, workspaceId, 'chat')).toBeUndefined()
    }
  )
})

it('keeps own-key order, prototype-named ids, and separate session and tab keys across snapshots', () => {
  const chat = { ...tab('__proto__'), entityId: '__proto__' }
  const snapshot: Record<string, Tab[]> = {}
  Object.setPrototypeOf(snapshot, { inherited: [chat] })
  Object.assign(snapshot, {
    constructor: [tab('terminal', 'terminal'), chat, chat],
    second: [chat]
  })
  expect(structuredChatWorkspacesBySessionId(snapshot, '__proto__')).toEqual([
    'constructor',
    'second'
  ])
  expect(chatWorkspaceByTabId(snapshot, '__proto__')).toBe('constructor')
  expect(chatWorkspaceByTabId(snapshot, 'terminal')).toBeNull()
  expect(structuredChatWorkspacesBySessionId({ second: [chat] }, '__proto__')).toEqual(['second'])
  expect(structuredChatWorkspacesBySessionId(snapshot, '__proto__')).toEqual([
    'constructor',
    'second'
  ])
})
