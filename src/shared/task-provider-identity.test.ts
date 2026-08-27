import { describe, expect, it } from 'vitest'
import {
  areTaskProviderIdentitiesEqual,
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart,
  type KanbanTaskProviderIdentity
} from './task-provider-identity'

const KANBAN_SERVER_URL = 'https://kanban.fpimi.ru'

describe('kanban task provider identity', () => {
  it('normalizes only the fixed HTTPS Kanban server', () => {
    expect(
      normalizeTaskProviderIdentity('kanban', {
        provider: 'kanban',
        serverUrl: ` ${KANBAN_SERVER_URL} `
      })
    ).toEqual({ provider: 'kanban', serverUrl: KANBAN_SERVER_URL })

    expect(
      normalizeTaskProviderIdentity('kanban', {
        provider: 'kanban',
        serverUrl: 'http://kanban.fpimi.ru'
      })
    ).toBeNull()
    expect(
      normalizeTaskProviderIdentity('kanban', {
        provider: 'kanban',
        serverUrl: 'https://kanban.example.com'
      })
    ).toBeNull()
    expect(
      normalizeTaskProviderIdentity('kanban', {
        provider: 'jira',
        serverUrl: KANBAN_SERVER_URL
      })
    ).toBeNull()
  })

  it('recognizes stored Kanban identities only for the fixed server', () => {
    expect(
      isStoredTaskProviderIdentity('kanban', {
        provider: 'kanban',
        serverUrl: KANBAN_SERVER_URL
      })
    ).toBe(true)
    expect(
      isStoredTaskProviderIdentity('kanban', {
        provider: 'kanban',
        serverUrl: 'https://other.example.com'
      })
    ).toBe(false)
    expect(isStoredTaskProviderIdentity('kanban', null)).toBe(true)
    expect(isStoredTaskProviderIdentity('kanban', undefined)).toBe(true)
  })

  it('compares and caches Kanban identities by server url', () => {
    const identity: KanbanTaskProviderIdentity = {
      provider: 'kanban',
      serverUrl: KANBAN_SERVER_URL
    }
    expect(
      areTaskProviderIdentitiesEqual(identity, { provider: 'kanban', serverUrl: KANBAN_SERVER_URL })
    ).toBe(true)
    expect(
      areTaskProviderIdentitiesEqual(identity, {
        provider: 'kanban',
        serverUrl: 'https://other'
      } as unknown as KanbanTaskProviderIdentity)
    ).toBe(false)
    expect(taskProviderIdentityCachePart(identity)).toBe(KANBAN_SERVER_URL)
  })
})
