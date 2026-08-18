import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from './ai-vault-types'
import {
  agentLabel,
  filterAiVaultSessions,
  folderGroupKey,
  folderLabel,
  groupAiVaultSessions,
  parseVaultQuery
} from './ai-vault-session-filters'
import { sessionPreviewSearchText } from './ai-vault-session-display'

const baseSession: AiVaultSession = {
  id: 'claude:1',
  executionHostId: 'local',
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
  previewMessages: [
    { role: 'user', text: 'add the scope tabs', timestamp: null },
    { role: 'assistant', text: 'done — added Workspace/Project/All', timestamp: null }
  ],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "cd '/Users/ada/repo/app' && claude --resume 'session-1'",
  subagent: null
}

const otherSession: AiVaultSession = {
  ...baseSession,
  id: 'codex:2',
  agent: 'codex',
  sessionId: 'session-2',
  title: 'Repair terminal tabs',
  cwd: '/Users/ada/other/packages/ui',
  branch: 'fix/terminal',
  filePath: '/Users/ada/.codex/sessions/session-2.jsonl',
  previewMessages: []
}

describe('/shared ai-vault-session-filters (lifted core)', () => {
  it('filters by agent, workspace scope, and plain/repo/path query terms', () => {
    expect(
      filterAiVaultSessions([baseSession, otherSession], {
        query: 'vault repo:repo path:app',
        agents: ['claude'],
        scope: 'workspace',
        sort: 'updated',
        activeWorktreePaths: ['/Users/ada/repo'],
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:1'])
  })

  it('hides empty sessions by default and keeps non-empty ones', () => {
    // A session only counts as empty without conversation previews or
    // recoverable signals — preview turns alone make it resumable content.
    const empty: AiVaultSession = {
      ...baseSession,
      id: 'claude:empty',
      messageCount: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0
    }
    expect(
      filterAiVaultSessions([baseSession, empty], {
        query: '',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:1'])
  })

  it('groups by folder', () => {
    const groups = groupAiVaultSessions([baseSession, otherSession], 'folder')
    expect(groups.map((group) => group.label).sort()).toEqual(['packages/ui', 'repo/app'])
  })

  it('folds trailing-slash and repeated-slash cwd spellings into one folder group', () => {
    const groups = groupAiVaultSessions(
      [
        { ...baseSession, cwd: '/Users/ada/repo/app' },
        { ...baseSession, id: 'claude:2', cwd: '/Users/ada/repo/app/' },
        { ...baseSession, id: 'claude:3', cwd: '/Users/ada//repo/app//' }
      ],
      'folder'
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions).toHaveLength(3)
    expect(groups[0].label).toBe('repo/app')
  })

  it('folds NFD and NFC cwd spellings into one folder group with an NFC label', () => {
    const groups = groupAiVaultSessions(
      [
        { ...baseSession, cwd: '/Users/ada/Café/app'.normalize('NFD') },
        { ...baseSession, id: 'claude:2', cwd: '/Users/ada/Café/app'.normalize('NFC') }
      ],
      'folder'
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions).toHaveLength(2)
    expect(groups[0].label).toBe('Café/app'.normalize('NFC'))
  })

  it('folds separator and case variants of one Windows folder', () => {
    const groups = groupAiVaultSessions(
      [
        { ...baseSession, cwd: 'C:\\Users\\Ada\\repo\\app' },
        { ...baseSession, id: 'claude:2', cwd: 'c:/users/ada/repo/app/' }
      ],
      'folder'
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions).toHaveLength(2)
  })

  it('folds the two WSL UNC aliases of one folder into a single group', () => {
    const groups = groupAiVaultSessions(
      [
        { ...baseSession, cwd: '//wsl.localhost/Ubuntu/home/ada/repo/app' },
        { ...baseSession, id: 'claude:2', cwd: '//wsl$/Ubuntu/home/ada/repo/app' }
      ],
      'folder'
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions.map((session) => session.id)).toEqual(['claude:1', 'claude:2'])
  })

  it('keeps case-distinct POSIX folders in separate groups', () => {
    const groups = groupAiVaultSessions(
      [
        { ...baseSession, cwd: '/home/ada/Foo' },
        { ...baseSession, id: 'claude:2', cwd: '/home/ada/foo' }
      ],
      'folder'
    )
    expect(groups).toHaveLength(2)
  })

  it('folds the project-grouping fallback onto the resolved folder project key', () => {
    const resolved = { ...baseSession, cwd: '/Users/ada/repo/app' }
    const unresolved = { ...baseSession, id: 'claude:2', cwd: '/Users/ada/repo/app/' }
    // Key literal, not folderGroupKey(), so the test still fails if both builders drift together.
    const groups = groupAiVaultSessions([resolved, unresolved], 'project', {
      sessionProjectById: new Map([
        [
          resolved.id,
          { kind: 'folder' as const, key: 'folder:/Users/ada/repo/app', label: 'repo/app' }
        ]
      ])
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions).toHaveLength(2)
  })

  it('keys unknown cwd separately from real folders', () => {
    expect(folderGroupKey(null)).toBe('unknown')
    expect(folderGroupKey('/Users/ada/repo/app')).toBe('folder:/Users/ada/repo/app')
  })

  it('parses repo: and path: operators from the query', () => {
    expect(parseVaultQuery('hello repo:orca path:/tmp world')).toEqual({
      terms: ['hello', 'world'],
      repoTerms: ['orca'],
      pathTerms: ['/tmp']
    })
  })

  it('parses quoted repo:/path: operator values containing spaces', () => {
    expect(parseVaultQuery('repo:"my repo" path:"/Users/ada/My Project"')).toEqual({
      terms: [],
      repoTerms: ['my repo'],
      pathTerms: ['/users/ada/my project']
    })
  })

  it('exposes a stable agent label and folder label', () => {
    expect(agentLabel('claude')).toBe('Claude')
    expect(folderLabel('/Users/ada/repo/app')).toBe('repo/app')
  })

  it('builds preview search text from conversation turns', () => {
    expect(sessionPreviewSearchText(baseSession)).toContain('scope tabs')
  })
})
