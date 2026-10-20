import { describe, expect, it } from 'vitest'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import { buildSessionsBoardColumns } from './sessions-board-column-model'

function makeSession(
  agent: AiVaultAgent,
  sessionId: string,
  overrides: Partial<AiVaultSession> = {}
): AiVaultSession {
  return {
    id: `local:${agent}:${sessionId}:/home/a/${agent}/${sessionId}.json`,
    executionHostId: 'local',
    agent,
    sessionId,
    title: `${agent} ${sessionId}`,
    cwd: `/home/a/projects/${sessionId}`,
    branch: null,
    model: null,
    filePath: `/home/a/${agent}/${sessionId}.json`,
    codexHome: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [{ role: 'user', text: 'hello', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `${agent} resume ${sessionId}`,
    subagent: null,
    ...overrides
  }
}

const NO_FILTERS = { query: '', hideEmptySessions: true }

describe('buildSessionsBoardColumns', () => {
  it('gives every agent with sessions exactly one column, labelled for that agent', () => {
    const columns = buildSessionsBoardColumns(
      [makeSession('claude', 'c1'), makeSession('codex', 'x1'), makeSession('claude', 'c2')],
      NO_FILTERS
    )

    expect(columns.map((column) => column.agent)).toEqual(['claude', 'codex'])
    expect(columns.map((column) => column.label)).toEqual(['Claude', 'Codex'])
    expect(columns.map((column) => column.sessions.length)).toEqual([2, 1])
  })

  it('omits agents that have no sessions rather than rendering an empty column', () => {
    const columns = buildSessionsBoardColumns([makeSession('codex', 'x1')], NO_FILTERS)

    expect(columns.map((column) => column.agent)).toEqual(['codex'])
    expect(columns.every((column) => column.sessions.length > 0)).toBe(true)
  })

  it('orders columns by session count and breaks ties by label', () => {
    const columns = buildSessionsBoardColumns(
      [
        makeSession('codex', 'x1'),
        makeSession('gemini', 'g1'),
        makeSession('claude', 'c1'),
        makeSession('claude', 'c2'),
        makeSession('gemini', 'g2')
      ],
      NO_FILTERS
    )

    // Claude and Gemini both hold two; "Claude" sorts before "Gemini".
    expect(columns.map((column) => column.label)).toEqual(['Claude', 'Gemini', 'Codex'])
  })

  it('keeps each column newest-first, the order the scan and filter produce', () => {
    const columns = buildSessionsBoardColumns(
      [
        makeSession('claude', 'older', { updatedAt: '2026-01-01T00:00:00.000Z' }),
        makeSession('claude', 'newer', { updatedAt: '2026-06-01T00:00:00.000Z' })
      ],
      NO_FILTERS
    )

    expect(columns[0].sessions.map((session) => session.sessionId)).toEqual(['newer', 'older'])
  })

  it('drops sessions and whole columns the query excludes', () => {
    const columns = buildSessionsBoardColumns(
      [
        makeSession('claude', 'c1', { title: 'Deploy the release' }),
        makeSession('codex', 'x1', { title: 'Unrelated chore' })
      ],
      { query: 'deploy', hideEmptySessions: true }
    )

    expect(columns.map((column) => column.agent)).toEqual(['claude'])
  })

  it('returns nothing when the query matches nothing', () => {
    expect(
      buildSessionsBoardColumns([makeSession('claude', 'c1')], {
        query: 'no-such-session-anywhere',
        hideEmptySessions: true
      })
    ).toEqual([])
  })

  it('hides zero-turn sessions only while the caller asks it to', () => {
    const empty = makeSession('claude', 'empty', {
      messageCount: 0,
      previewMessages: []
    })

    expect(buildSessionsBoardColumns([empty], NO_FILTERS)).toEqual([])
    expect(
      buildSessionsBoardColumns([empty], { query: '', hideEmptySessions: false })
    ).toHaveLength(1)
  })

  it('keeps recoverable zero-turn sessions even while hiding empty ones', () => {
    const queued = makeSession('codex', 'queued', {
      messageCount: 0,
      previewMessages: [],
      queuedMessageCount: 3
    })
    const columns = buildSessionsBoardColumns([queued], NO_FILTERS)

    expect(columns[0].sessions.map((session) => session.sessionId)).toEqual(['queued'])
  })
})
