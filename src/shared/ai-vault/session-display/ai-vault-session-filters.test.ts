import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../contracts/ai-vault-types'
import { filterAiVaultSessions, groupAiVaultSessions } from './ai-vault-session-filters'
import './ai-vault-session-display'

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
      filterAiVaultSessions(
        [
          baseSession,
          otherSession,
          { ...baseSession, id: 'wrong-agent', agent: 'codex' },
          { ...baseSession, id: 'outside-scope', cwd: '/outside/repo/app' },
          { ...baseSession, id: 'wrong-text', title: 'Unrelated request', branch: null },
          { ...baseSession, id: 'wrong-repo', cwd: '/Users/ada/repo/other/app' },
          {
            ...baseSession,
            id: 'wrong-path',
            cwd: '/Users/ada/repo/lib',
            filePath: '/transcripts/session.jsonl'
          }
        ],
        {
          query: 'vault repo:repo path:app',
          agents: ['claude'],
          scope: 'workspace',
          sort: 'updated',
          activeWorktreePaths: ['/Users/ada/repo'],
          hideEmptySessions: true
        }
      ).map((session) => session.id)
    ).toEqual(['claude:1'])
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
})

describe('/shared ai-vault-session-filters (hoisted matchers and sort keys)', () => {
  it('matches workspace scope across host path spellings', () => {
    // Verify native containment across Windows folding, WSL aliases/mounts, trailing separators and near-miss siblings.
    const cases: [workspace: string, cwd: string, matched: boolean][] = [
      ['C:\\Users\\Ada\\repo', 'c:/users/ada/repo/app', true],
      ['C:/Users/Ada/repo/', 'C:\\Users\\Ada\\repo', true],
      ['C:\\Users\\Ada\\repo', 'C:\\Users\\Ada\\repo-other', false],
      ['C:\\', 'C:\\anything', true],
      ['//wsl.localhost/Ubuntu/home/ada/repo', '//wsl$/Ubuntu/home/ada/repo/app', true],
      ['//wsl.localhost/Ubuntu/home/Ada/Repo', '//wsl$/Ubuntu/home/Ada/Repo/App', true],
      ['//wsl.localhost/Ubuntu/home/Ada/Repo', '//wsl$/Ubuntu/home/ada/repo/App', false],
      ['//wsl$/Ubuntu/home/ada/repo', '//WSL.LOCALHOST/ubuntu/home/ada/repo', true],
      ['//wsl.localhost/Ubuntu/home/ada/repo', '//wsl.localhost/Debian/home/ada/repo', false],
      ['//wsl.localhost/Ubuntu/mnt/c/work', '/mnt/c/work/app', true],
      ['/Users/ada/repo', '/Users/ada/repo//app/', true],
      ['/Users/ada/repo', '/Users/Ada/repo/app', false],
      ['/Users/ada/repo', '/Users/ada/repository', false],
      ['/', '/anywhere', true]
    ]
    for (const [workspace, cwd, expected] of cases) {
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
})

describe('filterAiVaultSessions symlinked workspace', () => {
  it('keeps a session recorded under the real path when the host aliased it to the workspace', () => {
    const recordedUnderRealPath: AiVaultSession = {
      ...baseSession,
      cwd: '/data/src/repo',
      cwdAliases: ['/Users/ada/repo']
    }

    const filtered = filterAiVaultSessions([recordedUnderRealPath], {
      query: '',
      agents: ['claude'],
      scope: 'workspace',
      sort: 'updated',
      activeWorktreePaths: ['/Users/ada/repo'],
      hideEmptySessions: false
    })

    expect(filtered.map((entry) => entry.cwd)).toEqual(['/data/src/repo'])
  })
})
