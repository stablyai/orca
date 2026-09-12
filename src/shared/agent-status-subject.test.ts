import { describe, expect, it } from 'vitest'
import {
  agentStatusSubjectFromLegacyPane,
  agentStatusSubjectKey,
  agentStatusSubjectsEqual,
  makePtyAgentStatusSubject,
  makeStructuredAgentStatusSubject,
  parseAgentStatusSubject,
  parseAgentStatusSubjectKey
} from './agent-status-subject'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function scope(overrides: Record<string, unknown> = {}) {
  return {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: 'repo-1::/workspace/app',
    workspaceKind: 'git-worktree' as const,
    ...overrides
  }
}

describe('AgentStatusSubject', () => {
  it('keeps identical pane and session strings distinct across every execution scope', () => {
    const subjects = [
      makePtyAgentStatusSubject(scope(), PANE_KEY),
      makePtyAgentStatusSubject(scope({ wslDistro: 'Ubuntu' }), PANE_KEY),
      makePtyAgentStatusSubject(scope({ executionHostId: 'ssh:target-a' }), PANE_KEY),
      makePtyAgentStatusSubject(scope({ executionHostId: 'ssh:target-b' }), PANE_KEY),
      makePtyAgentStatusSubject(scope({ executionHostId: 'runtime:paired-a' }), PANE_KEY),
      makeStructuredAgentStatusSubject(scope(), SESSION_ID),
      makeStructuredAgentStatusSubject(scope({ executionHostId: 'runtime:paired-a' }), SESSION_ID)
    ]

    expect(new Set(subjects.map(agentStatusSubjectKey))).toHaveLength(subjects.length)
  })

  it('validates git-worktree and folder subjects and round-trips their canonical keys', () => {
    const git = makeStructuredAgentStatusSubject(scope(), SESSION_ID)
    const folder = makeStructuredAgentStatusSubject(
      scope({ workspaceId: 'folder:notes', workspaceKind: 'folder' }),
      SESSION_ID
    )

    expect(parseAgentStatusSubject(git)).toEqual(git)
    expect(parseAgentStatusSubject(folder)).toEqual(folder)
    expect(parseAgentStatusSubjectKey(agentStatusSubjectKey(folder))).toEqual(folder)
    expect(agentStatusSubjectsEqual(folder, { ...folder })).toBe(true)
    expect(agentStatusSubjectsEqual(git, folder)).toBe(false)
  })

  it('rejects malformed, unknown, and over-specified subjects', () => {
    expect(parseAgentStatusSubject({ kind: 'future' })).toBeNull()
    expect(
      parseAgentStatusSubject({
        kind: 'pty',
        ...scope(),
        paneKey: ''
      })
    ).toBeNull()
    expect(
      parseAgentStatusSubject({
        kind: 'structured-session',
        ...scope(),
        sessionId: SESSION_ID,
        paneKey: PANE_KEY
      })
    ).toBeNull()
    expect(
      parseAgentStatusSubject({
        kind: 'pty',
        ...scope({ executionHostId: 'somewhere' }),
        paneKey: PANE_KEY
      })
    ).toBeNull()
  })

  it('migrates legacy local, WSL, SSH, and folder pane identities without changing the pane key', () => {
    expect(agentStatusSubjectFromLegacyPane({ paneKey: PANE_KEY })).toMatchObject({
      kind: 'pty',
      paneKey: PANE_KEY
    })
    expect(
      agentStatusSubjectFromLegacyPane({
        paneKey: PANE_KEY,
        worktreeId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\workspace'
      }).wslDistro
    ).toBe('Ubuntu')
    expect(
      agentStatusSubjectFromLegacyPane({ paneKey: PANE_KEY, connectionId: 'target-a' })
        .executionHostId
    ).toBe('ssh:target-a')
    expect(
      agentStatusSubjectFromLegacyPane({ paneKey: PANE_KEY, worktreeId: 'folder:notes' })
        .workspaceKind
    ).toBe('folder')
  })
})
