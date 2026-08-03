import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from './ai-vault-types'
import {
  agentLabel,
  filterAiVaultSessions,
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

  it('groups trailing-slash variants of the same folder as one group', () => {
    // The folder key must trim trailing slashes so a cwd recorded with and without
    // one collapse to a single group instead of two visually identical labels.
    const trailingSlash: AiVaultSession = {
      ...baseSession,
      id: 'trailing',
      cwd: '/Users/ada/repo/app/'
    }
    const groups = groupAiVaultSessions([baseSession, trailingSlash], 'folder')
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('repo/app')
    expect(groups[0].sessions.map((session) => session.id).sort()).toEqual(['claude:1', 'trailing'])
  })

  it('groups NFC and NFD spellings of the same non-ASCII folder as one group', () => {
    // macOS file pickers/on-disk names yield NFD while agents record cwd in NFC (#10832);
    // the comparison-key normalizer folds them, so both sessions land in one group.
    const nfc: AiVaultSession = { ...baseSession, id: 'nfc', cwd: '/Users/ada/repo/Caf\u00E9' }
    const nfd: AiVaultSession = { ...baseSession, id: 'nfd', cwd: '/Users/ada/repo/Cafe\u0301' }
    const groups = groupAiVaultSessions([nfc, nfd], 'folder')
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions.map((session) => session.id).sort()).toEqual(['nfc', 'nfd'])
  })

  it('groups case-variant POSIX spellings of the same folder as one group', () => {
    // getFolderGroupKey lowercases on top of the POSIX-branch normalizer (which does not),
    // locking the all-platforms case-fold the comment on it promises.
    const lower: AiVaultSession = { ...baseSession, id: 'lower', cwd: '/Users/ada/repo/app' }
    const mixed: AiVaultSession = { ...baseSession, id: 'mixed', cwd: '/Users/ada/repo/App' }
    const groups = groupAiVaultSessions([lower, mixed], 'folder')
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions.map((session) => session.id).sort()).toEqual(['lower', 'mixed'])
  })

  it('groups the wsl.localhost and wsl$ UNC aliases of the same WSL folder as one group', () => {
    // normalizeRuntimePathForComparison folds both UNC aliases to //wsl/<distro>/...,
    // so a WSL session recorded under either alias lands in one folder group.
    const localhost: AiVaultSession = {
      ...baseSession,
      id: 'wsl-localhost',
      cwd: '//wsl.localhost/Ubuntu/home/ada/repo/app'
    }
    const dollar: AiVaultSession = {
      ...baseSession,
      id: 'wsl-dollar',
      cwd: '//wsl$/Ubuntu/home/ada/repo/app'
    }
    const groups = groupAiVaultSessions([localhost, dollar], 'folder')
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions.map((session) => session.id).sort()).toEqual([
      'wsl-dollar',
      'wsl-localhost'
    ])
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
