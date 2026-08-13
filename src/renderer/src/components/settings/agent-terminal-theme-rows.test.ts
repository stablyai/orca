import { describe, expect, it } from 'vitest'
import { collectAgentTerminalThemeRows, isAgentTerminalThemeRowsEmptySuccess, isAgentTerminalThemeRowsFailed, isAgentTerminalThemeRowsLoading } from './agent-terminal-theme-rows'

describe('collectAgentTerminalThemeRows', () => {
  it('unions local and cached remote detections and sorts by catalog order', () => {
    const rows = collectAgentTerminalThemeRows(
      {
        localDetectedIds: ['codex'],
        remoteDetectedAgentIds: { 'ssh-1': ['cursor', 'claude'] },
        runtimeDetectedAgentIds: {}
      },
      [],
      []
    )

    expect(rows.map((row) => row.id)).toEqual(['claude', 'codex', 'cursor'])
    expect(rows.every((row) => !row.disabled)).toBe(true)
  })

  it('includes cached runtime detections', () => {
    const rows = collectAgentTerminalThemeRows(
      {
        localDetectedIds: [],
        remoteDetectedAgentIds: {},
        runtimeDetectedAgentIds: { 'env-1': ['grok'] }
      },
      [],
      []
    )

    expect(rows.map((row) => row.id)).toEqual(['grok'])
  })

  it('hides disabled agents unless a persisted override exists', () => {
    const hidden = collectAgentTerminalThemeRows(
      {
        localDetectedIds: ['claude', 'codex'],
        remoteDetectedAgentIds: {},
        runtimeDetectedAgentIds: {}
      },
      [],
      ['claude']
    )
    const persisted = collectAgentTerminalThemeRows(
      {
        localDetectedIds: ['codex'],
        remoteDetectedAgentIds: {},
        runtimeDetectedAgentIds: {}
      },
      ['claude'],
      ['claude']
    )

    expect(hidden.map((row) => row.id)).toEqual(['codex'])
    expect(persisted.map((row) => row.id)).toEqual(['claude', 'codex'])
    expect(persisted.find((row) => row.id === 'claude')?.disabled).toBe(true)
  })

  it('always lists persisted override keys even when undetected', () => {
    const rows = collectAgentTerminalThemeRows(
      {
        localDetectedIds: ['claude'],
        remoteDetectedAgentIds: {},
        runtimeDetectedAgentIds: {}
      },
      ['codex'],
      []
    )

    expect(rows.map((row) => row.id)).toEqual(['claude', 'codex'])
  })

  it('drops non-tui persisted keys', () => {
    const rows = collectAgentTerminalThemeRows(
      {
        localDetectedIds: null,
        remoteDetectedAgentIds: { 'ssh-1': null },
        runtimeDetectedAgentIds: {}
      },
      ['not-an-agent', 'claude'],
      []
    )

    expect(rows.map((row) => row.id)).toEqual(['claude'])
  })
})

describe('agent terminal theme row status', () => {
  it('shows detecting only while local detection is in flight with nothing else to list', () => {
    expect(
      isAgentTerminalThemeRowsLoading({
        localDetectedIds: null,
        isLoading: true,
        persistedKeyCount: 0,
        cachedDetectedIds: []
      })
    ).toBe(true)
    expect(
      isAgentTerminalThemeRowsLoading({
        localDetectedIds: null,
        isLoading: true,
        persistedKeyCount: 0,
        cachedDetectedIds: ['codex']
      })
    ).toBe(false)
    expect(
      isAgentTerminalThemeRowsLoading({
        localDetectedIds: [],
        isLoading: false,
        persistedKeyCount: 0,
        cachedDetectedIds: []
      })
    ).toBe(false)
  })

  it('treats a finished empty local probe as failure when there are no rows', () => {
    expect(
      isAgentTerminalThemeRowsFailed({
        localDetectedIds: null,
        isLoading: false,
        detectionFailed: false,
        rowCount: 0
      })
    ).toBe(true)
    expect(
      isAgentTerminalThemeRowsFailed({
        localDetectedIds: null,
        isLoading: false,
        detectionFailed: true,
        rowCount: 1
      })
    ).toBe(false)
  })

  it('shows empty success only after local detection resolved with no rows or overrides', () => {
    expect(
      isAgentTerminalThemeRowsEmptySuccess({
        localDetectedIds: [],
        rowCount: 0,
        persistedKeyCount: 0
      })
    ).toBe(true)
    expect(
      isAgentTerminalThemeRowsEmptySuccess({
        localDetectedIds: null,
        rowCount: 0,
        persistedKeyCount: 0
      })
    ).toBe(false)
  })
})
