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
import { AiVaultSessionSearchIndex } from './ai-vault-session-index'
import { createAiVaultTestSession } from './ai-vault-session-test-session'

const baseSession: AiVaultSession = createAiVaultTestSession({
  id: 'claude:1',
  sessionId: 'session-1'
})

const otherSession: AiVaultSession = createAiVaultTestSession({
  id: 'codex:2',
  agent: 'codex',
  sessionId: 'session-2',
  title: 'Repair terminal tabs',
  cwd: '/Users/ada/other/packages/ui',
  branch: 'fix/terminal',
  filePath: '/Users/ada/.codex/sessions/session-2.jsonl',
  previewMessages: []
})

const emptyParsedQueryExtras = {
  modelTerms: [],
  branchTerms: [],
  hostTerms: [],
  afterMs: null,
  beforeMs: null
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

  it('keeps card-term matching when searchScope is unset', () => {
    expect(
      filterAiVaultSessions([baseSession, otherSession], {
        query: 'repair',
        agents: ['claude', 'codex'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['codex:2'])
  })

  it('skips card terms for an explicit full-text rg scope', () => {
    expect(
      filterAiVaultSessions([baseSession, otherSession], {
        query: 'repair',
        agents: ['claude', 'codex'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true,
        searchScope: 'full'
      }).map((session) => session.id)
    ).toEqual(['claude:1', 'codex:2'])
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
      pathTerms: ['/tmp'],
      ...emptyParsedQueryExtras
    })
  })

  it('parses quoted repo:/path: operator values containing spaces', () => {
    expect(parseVaultQuery('repo:"my repo" path:"/Users/ada/My Project"')).toEqual({
      terms: [],
      repoTerms: ['my repo'],
      pathTerms: ['/users/ada/my project'],
      ...emptyParsedQueryExtras
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

describe('filterAiVaultSessions dimensions', () => {
  const nowMs = Date.parse('2026-05-08T12:00:00.000Z')

  it('filters by time range, host, model:, branch:, and after: operators', () => {
    const localRecent = createAiVaultTestSession({
      id: 'local-recent',
      title: 'Recent local pairing fix',
      updatedAt: '2026-05-08T08:00:00.000Z',
      model: 'claude-sonnet-4-5',
      branch: 'fix/pairing'
    })
    const wslOld = createAiVaultTestSession({
      id: 'wsl-old',
      title: 'Old WSL pairing',
      cwd: String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`,
      filePath: String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude\projects\old.jsonl`,
      updatedAt: '2026-03-01T08:00:00.000Z',
      model: 'gpt-5.5',
      branch: 'main'
    })
    const sessions = [localRecent, wslOld]
    const index = new AiVaultSessionSearchIndex()
    index.sync(sessions)

    expect(
      filterAiVaultSessions(
        sessions,
        {
          query: '',
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: true,
          timeRange: '7d',
          hosts: ['local']
        },
        { index, nowMs }
      ).map((session) => session.id)
    ).toEqual(['local-recent'])

    expect(
      filterAiVaultSessions(
        sessions,
        {
          query: 'host:wsl model:gpt branch:main',
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: true
        },
        { index, nowMs }
      ).map((session) => session.id)
    ).toEqual(['wsl-old'])

    expect(
      filterAiVaultSessions(
        sessions,
        {
          query: 'after:2026-05-07',
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: true
        },
        { index, nowMs }
      ).map((session) => session.id)
    ).toEqual(['local-recent'])
  })

  it('reuses an existing index so a later query does not rebuild postings', () => {
    const session = createAiVaultTestSession({
      id: 'claude:1',
      title: 'Fixture ordering'
    })
    const index = new AiVaultSessionSearchIndex()
    index.sync([session])
    const upsertSpySize = index.size

    const matches = filterAiVaultSessions(
      [session],
      {
        query: 'fixture',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true,
        searchScope: 'title'
      },
      { index }
    )

    expect(matches.map((entry) => entry.id)).toEqual(['claude:1'])
    expect(index.size).toBe(upsertSpySize)
  })

  it('uses title and summary card fields and leaves full-text terms for rg', () => {
    const titled = createAiVaultTestSession({
      id: 'title-hit',
      title: 'alpha-title-only',
      previewMessages: [{ role: 'user', text: 'unrelated preview', timestamp: null }]
    })
    const summarized = createAiVaultTestSession({
      id: 'summary-hit',
      title: 'Other session',
      previewMessages: [{ role: 'user', text: 'alpha-summary-only first prompt', timestamp: null }]
    })
    const sessions = [titled, summarized]
    const index = new AiVaultSessionSearchIndex()
    index.sync(sessions)

    expect(
      filterAiVaultSessions(
        sessions,
        {
          query: 'alpha-title-only',
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: true,
          searchScope: 'title'
        },
        { index }
      ).map((session) => session.id)
    ).toEqual(['title-hit'])

    expect(
      filterAiVaultSessions(
        sessions,
        {
          query: 'alpha-summary-only',
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: true,
          searchScope: 'summary'
        },
        { index }
      ).map((session) => session.id)
    ).toEqual(['summary-hit'])

    expect(
      filterAiVaultSessions(
        sessions,
        {
          query: 'alpha-title-only',
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: true,
          searchScope: 'full'
        },
        { index }
      ).map((session) => session.id)
    ).toEqual(['title-hit', 'summary-hit'])
  })
})
