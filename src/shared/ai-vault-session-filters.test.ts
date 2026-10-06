import { describe, expect, it, vi } from 'vitest'
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
import { isPathInsideOrEqual } from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'

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

describe('/shared ai-vault-session-filters (hoisted matchers and sort keys)', () => {
  it('prepares workspace path matching once for a large session filter pass', () => {
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      ...baseSession,
      id: String(i),
      cwd: `/other/${i}`
    }))
    const activeWorktreePaths = Array.from({ length: 100 }, (_, i) => `/repo/${i}`)
    const normalize = vi.spyOn(String.prototype, 'normalize')
    try {
      expect(
        filterAiVaultSessions(sessions, {
          query: '',
          agents: ['claude'],
          scope: 'workspace',
          sort: 'updated',
          activeWorktreePaths,
          hideEmptySessions: false
        })
      ).toEqual([])
      expect(normalize.mock.calls.length).toBeLessThanOrEqual(1100)
    } finally {
      normalize.mockRestore()
    }
  })

  it('does not read transcript previews for empty or field-only queries', () => {
    let reads = 0
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      ...baseSession,
      id: String(i),
      get previewMessages() {
        reads++
        return baseSession.previewMessages
      }
    }))
    for (const query of ['', 'repo:repo', 'path:app']) {
      expect(
        filterAiVaultSessions(sessions, {
          query,
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: false
        })
      ).toHaveLength(1000)
    }
    expect(reads).toBe(0)
    expect(
      filterAiVaultSessions(sessions, {
        query: 'scope',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: false
      })
    ).toHaveLength(1000)
    expect(reads).toBeGreaterThan(0)
  })

  it('parses each sort timestamp once with original ordering, including invalid dates', () => {
    const sessions = Array.from({ length: 2000 }, (_, i) => ({
      ...baseSession,
      id: String(i),
      updatedAt:
        i % 131 === 0
          ? 'invalid'
          : new Date(1700000000000 + ((i * 173) % 1999) * 1000).toISOString()
    }))
    const parse = vi.spyOn(Date, 'parse')
    let actual: AiVaultSession[]
    let expected: AiVaultSession[]
    try {
      expected = [...sessions].sort(
        (a, b) => Date.parse(b.updatedAt ?? b.modifiedAt) - Date.parse(a.updatedAt ?? a.modifiedAt)
      )
      expect(parse.mock.calls.length).toBeGreaterThan(10_000)
      parse.mockClear()
      actual = filterAiVaultSessions(sessions, {
        query: '',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: false
      })
      expect(parse).toHaveBeenCalledTimes(2000)
    } finally {
      parse.mockRestore()
    }
    actual.forEach((session, i) => expect(session).toBe(expected[i]))
  })

  it('matches workspace scope identically to the pre-hoist path predicate', () => {
    // The hoisted matcher must agree with isPathInsideOrEqual on every spelling the
    // supported hosts produce: Windows case/separator folding, trailing separators,
    // both WSL UNC aliases, /mnt drive mounts and near-miss sibling directories.
    const cases: [workspace: string, cwd: string][] = [
      ['C:\\Users\\Ada\\repo', 'c:/users/ada/repo/app'],
      ['C:/Users/Ada/repo/', 'C:\\Users\\Ada\\repo'],
      ['C:\\Users\\Ada\\repo', 'C:\\Users\\Ada\\repo-other'],
      ['C:\\', 'C:\\anything'],
      ['//wsl.localhost/Ubuntu/home/ada/repo', '//wsl$/Ubuntu/home/ada/repo/app'],
      ['//wsl.localhost/Ubuntu/home/Ada/Repo', '//wsl$/Ubuntu/home/Ada/Repo/App'],
      ['//wsl.localhost/Ubuntu/home/Ada/Repo', '//wsl$/Ubuntu/home/ada/repo/App'],
      ['//wsl$/Ubuntu/home/ada/repo', '//WSL.LOCALHOST/ubuntu/home/ada/repo'],
      ['//wsl.localhost/Ubuntu/home/ada/repo', '//wsl.localhost/Debian/home/ada/repo'],
      ['//wsl.localhost/Ubuntu/mnt/c/work', '/mnt/c/work/app'],
      ['/Users/ada/repo', '/Users/ada/repo//app/'],
      ['/Users/ada/repo', '/Users/Ada/repo/app'],
      ['/Users/ada/repo', '/Users/ada/repository'],
      ['/', '/anywhere']
    ]
    for (const [workspace, cwd] of cases) {
      const expected =
        isPathInsideOrEqual(workspace, cwd) ||
        (parseWslUncPath(workspace)
          ? isPathInsideOrEqual(parseWslUncPath(workspace)!.linuxPath, cwd)
          : false)
      const actual = filterAiVaultSessions([{ ...baseSession, cwd }], {
        query: '',
        agents: ['claude'],
        scope: 'workspace',
        sort: 'updated',
        activeWorktreePaths: [workspace],
        hideEmptySessions: false
      })
      expect({ workspace, cwd, matched: actual.length === 1 }).toEqual({
        workspace,
        cwd,
        matched: expected
      })
    }
  })

  it('orders by creation time identically to the per-comparison parse', () => {
    const sessions = Array.from({ length: 500 }, (_, i) => ({
      ...baseSession,
      id: String(i),
      createdAt:
        i % 37 === 0 ? 'invalid' : new Date(1700000000000 + ((i * 91) % 499) * 1000).toISOString()
    }))
    const expected = [...sessions].sort(
      (a, b) => Date.parse(b.createdAt ?? b.modifiedAt) - Date.parse(a.createdAt ?? a.modifiedAt)
    )
    const actual = filterAiVaultSessions(sessions, {
      query: '',
      agents: ['claude'],
      scope: 'all',
      sort: 'created',
      activeWorktreePaths: [],
      hideEmptySessions: false
    })
    actual.forEach((session, i) => expect(session).toBe(expected[i]))
  })
})
