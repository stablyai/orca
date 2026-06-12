import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  filterAiVaultSessions,
  folderLabel,
  groupAiVaultSessions,
  parseVaultQuery
} from './ai-vault-session-filters'

const baseSession: AiVaultSession = {
  id: 'claude:1',
  agent: 'claude',
  sessionId: 'session-1',
  title: 'Implement vault filters',
  cwd: '/Users/ada/repo/app',
  branch: 'feature/vault',
  model: 'claude-sonnet-4-5',
  filePath: '/Users/ada/.claude/projects/session-1.jsonl',
  codexHome: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:10:00.000Z',
  modifiedAt: '2026-05-01T10:10:00.000Z',
  messageCount: 4,
  totalTokens: 1200,
  previewMessages: [],
  resumeCommand: "cd '/Users/ada/repo/app' && claude --resume 'session-1'"
}

describe('filterAiVaultSessions', () => {
  it('filters by workspace, agent, plain terms, repo: and path: operators', () => {
    const sessions: AiVaultSession[] = [
      baseSession,
      {
        ...baseSession,
        id: 'codex:2',
        agent: 'codex',
        sessionId: 'session-2',
        title: 'Repair terminal tabs',
        cwd: '/Users/ada/other/packages/ui',
        branch: 'fix/terminal',
        filePath: '/Users/ada/.codex/sessions/session-2.jsonl'
      }
    ]

    expect(
      filterAiVaultSessions(sessions, {
        query: 'vault repo:repo path:app',
        agents: ['claude'],
        scope: 'workspace',
        sort: 'updated',
        activeWorktreePath: '/Users/ada/repo',
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:1'])
  })

  it('hides empty metadata-only sessions when requested', () => {
    const emptySession: AiVaultSession = {
      ...baseSession,
      id: 'claude:empty',
      sessionId: 'empty-session',
      title: 'Claude empty-session',
      messageCount: 0
    }

    expect(
      filterAiVaultSessions([emptySession, baseSession], {
        query: '',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePath: null,
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:1'])

    const shownWhenAllowed = filterAiVaultSessions([emptySession, baseSession], {
      query: '',
      agents: ['claude'],
      scope: 'all',
      sort: 'updated',
      activeWorktreePath: null,
      hideEmptySessions: false
    }).map((session) => session.id)

    expect(new Set(shownWhenAllowed)).toEqual(new Set(['claude:1', 'claude:empty']))
  })

  it('matches Windows workspace paths case-insensitively', () => {
    expect(
      filterAiVaultSessions(
        [
          {
            ...baseSession,
            cwd: 'C:\\Users\\Ada\\Repo\\App'
          }
        ],
        {
          query: '',
          agents: ['claude'],
          scope: 'workspace',
          sort: 'updated',
          activeWorktreePath: 'c:\\users\\ada\\repo',
          hideEmptySessions: true
        }
      )
    ).toHaveLength(1)
  })
})

describe('groupAiVaultSessions', () => {
  it('groups by folder or agent without changing session order', () => {
    const sessions: AiVaultSession[] = [
      baseSession,
      { ...baseSession, id: 'codex:2', agent: 'codex', cwd: '/Users/ada/repo/app' }
    ]

    expect(groupAiVaultSessions(sessions, 'folder')).toEqual([
      { key: '/users/ada/repo/app', label: 'repo/app', sessions }
    ])
    expect(groupAiVaultSessions(sessions, 'agent').map((group) => group.label)).toEqual([
      'Claude',
      'Codex'
    ])
  })
})

describe('parseVaultQuery', () => {
  it('keeps quoted terms together', () => {
    expect(parseVaultQuery('"resume picker" repo:orca path:src')).toEqual({
      terms: ['resume picker'],
      repoTerms: ['orca'],
      pathTerms: ['src']
    })
  })
})

describe('folderLabel', () => {
  it('uses the last two path segments for compact labels', () => {
    expect(folderLabel('C:\\Users\\Ada\\repo\\app')).toBe('repo/app')
  })
})
