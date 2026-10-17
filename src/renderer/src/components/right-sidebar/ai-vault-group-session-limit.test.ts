import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { buildAiVaultListRows } from './ai-vault-group-session-limit'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { AiVaultListRow } from './AiVaultVirtualRow'

const baseSession: AiVaultSession = {
  id: 'claude:0',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'session-0',
  title: 'Session',
  cwd: '/Users/ada/repo/app',
  branch: null,
  model: null,
  filePath: '/Users/ada/.claude/projects/session-0.jsonl',
  codexHome: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:10:00.000Z',
  modifiedAt: '2026-05-01T10:10:00.000Z',
  messageCount: 4,
  totalTokens: 1200,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "claude --resume 'session-0'",
  subagent: null
}

function group(key: string, count: number, label: string | null = key): AiVaultSessionListGroup {
  return {
    key,
    label,
    sessions: Array.from({ length: count }, (_, index) => ({
      ...baseSession,
      id: `${key}:${index}`
    }))
  }
}

function describeRows(rows: readonly AiVaultListRow[]): string[] {
  return rows.map((row) => {
    if (row.type === 'group') {
      return `group ${row.group.key} (${row.group.sessions.length})`
    }
    if (row.type === 'group-more') {
      return `${row.expanded ? 'fewer' : 'more'} ${row.groupKey} +${row.hiddenCount}`
    }
    return row.session.id
  })
}

const none = new Set<string>()

describe('buildAiVaultListRows', () => {
  it('shows every session under each header when the limit is All', () => {
    const rows = buildAiVaultListRows({
      groups: [group('a', 4), group('b', 1)],
      collapsedGroups: none,
      groupSessionLimit: 'all',
      expandedGroups: none
    })

    expect(describeRows(rows)).toEqual([
      'group a (4)',
      'a:0',
      'a:1',
      'a:2',
      'a:3',
      'group b (1)',
      'b:0'
    ])
  })

  it('keeps the first N sessions of each group in their sorted order and adds a Show more row', () => {
    const rows = buildAiVaultListRows({
      groups: [group('a', 5), group('b', 2), group('c', 3)],
      collapsedGroups: none,
      groupSessionLimit: 3,
      expandedGroups: none
    })

    expect(describeRows(rows)).toEqual([
      'group a (5)',
      'a:0',
      'a:1',
      'a:2',
      'more a +2',
      'group b (2)',
      'b:0',
      'b:1',
      'group c (3)',
      'c:0',
      'c:1',
      'c:2'
    ])
  })

  it('reveals the whole group with a Show fewer row once that group is expanded', () => {
    const rows = buildAiVaultListRows({
      groups: [group('a', 5), group('b', 4)],
      collapsedGroups: none,
      groupSessionLimit: 3,
      expandedGroups: new Set(['a'])
    })

    expect(describeRows(rows)).toEqual([
      'group a (5)',
      'a:0',
      'a:1',
      'a:2',
      'a:3',
      'a:4',
      'fewer a +2',
      'group b (4)',
      'b:0',
      'b:1',
      'b:2',
      'more b +1'
    ])
  })

  it('emits only the header for a collapsed group, with no Show more row', () => {
    const rows = buildAiVaultListRows({
      groups: [group('a', 5)],
      collapsedGroups: new Set(['a']),
      groupSessionLimit: 3,
      expandedGroups: none
    })

    expect(describeRows(rows)).toEqual(['group a (5)'])
  })

  it('never caps label-less groups such as search results', () => {
    const rows = buildAiVaultListRows({
      groups: [group('search-results', 6, null)],
      collapsedGroups: new Set(['search-results']),
      groupSessionLimit: 3,
      expandedGroups: none
    })

    expect(rows).toHaveLength(6)
    expect(rows.every((row) => row.type === 'session')).toBe(true)
  })
})
