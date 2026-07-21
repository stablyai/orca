// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAiVaultPanelTransientStateForTests,
  MAX_AI_VAULT_DISCLOSURE_STATE_ENTRIES,
  useAiVaultPanelTransientState
} from './ai-vault-panel-transient-state'

type AiVaultPanelContext = {
  activeProjectKey: string | null
  activeWorktreePath: string | null
}

const AVAILABLE_CONTEXT: AiVaultPanelContext = {
  activeProjectKey: 'project:orca',
  activeWorktreePath: '/repo'
}

const UNAVAILABLE_PROJECT_CONTEXT: AiVaultPanelContext = {
  activeProjectKey: null,
  activeWorktreePath: '/repo'
}

const UNAVAILABLE_WORKSPACE_CONTEXT: AiVaultPanelContext = {
  activeProjectKey: 'project:orca',
  activeWorktreePath: null
}

beforeEach(clearAiVaultPanelTransientStateForTests)
afterEach(clearAiVaultPanelTransientStateForTests)

describe('useAiVaultPanelTransientState', () => {
  it('restores scope and disclosure choices when the panel remounts', () => {
    const first = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))

    act(() => {
      first.result.current.selectScope('project')
      first.result.current.toggleGroup('project:orca')
      first.result.current.toggleSessionDetails('local:codex:session-1:/session.jsonl')
    })
    first.unmount()

    const restored = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))
    expect(restored.result.current.scope).toBe('project')
    expect(restored.result.current.collapsedGroups).toEqual(new Set(['project:orca']))
    expect(restored.result.current.expandedSessionIds).toEqual(
      new Set(['local:codex:session-1:/session.jsonl'])
    )
  })

  it('falls back to all without forgetting a preferred project scope', () => {
    const first = renderHook(
      (context: AiVaultPanelContext) => useAiVaultPanelTransientState(context),
      { initialProps: AVAILABLE_CONTEXT }
    )
    act(() => first.result.current.selectScope('project'))
    first.unmount()

    const restored = renderHook(
      (context: AiVaultPanelContext) => useAiVaultPanelTransientState(context),
      { initialProps: UNAVAILABLE_PROJECT_CONTEXT }
    )
    expect(restored.result.current.scope).toBe('all')

    restored.rerender(AVAILABLE_CONTEXT)
    expect(restored.result.current.scope).toBe('project')
  })

  it('restores the default workspace scope after an unavailable-context remount', () => {
    const first = renderHook(
      (context: AiVaultPanelContext) => useAiVaultPanelTransientState(context),
      { initialProps: AVAILABLE_CONTEXT }
    )
    expect(first.result.current.scope).toBe('workspace')

    first.rerender(UNAVAILABLE_WORKSPACE_CONTEXT)
    expect(first.result.current.scope).toBe('all')
    first.unmount()

    const restored = renderHook(
      (context: AiVaultPanelContext) => useAiVaultPanelTransientState(context),
      { initialProps: UNAVAILABLE_WORKSPACE_CONTEXT }
    )
    expect(restored.result.current.scope).toBe('all')

    restored.rerender(AVAILABLE_CONTEXT)
    expect(restored.result.current.scope).toBe('workspace')
  })

  it('keeps an explicit all scope sticky across context changes and remounts', () => {
    const first = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))
    act(() => first.result.current.selectScope('all'))
    first.unmount()

    const restored = renderHook(() =>
      useAiVaultPanelTransientState({ activeProjectKey: null, activeWorktreePath: null })
    )
    expect(restored.result.current.scope).toBe('all')
    restored.unmount()

    const availableAgain = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))
    expect(availableAgain.result.current.scope).toBe('all')
  })

  it('uses the session cache as the source of truth for rapid toggles', () => {
    const hook = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))

    act(() => {
      hook.result.current.toggleGroup('project:orca')
      hook.result.current.toggleGroup('project:orca')
      hook.result.current.toggleSessionDetails('session-1')
      hook.result.current.toggleSessionDetails('session-1')
    })

    expect(hook.result.current.collapsedGroups).toEqual(new Set())
    expect(hook.result.current.expandedSessionIds).toEqual(new Set())
  })

  it('keeps concurrent consumers synchronized', () => {
    const first = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))
    const second = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))

    act(() => {
      first.result.current.selectScope('project')
      first.result.current.toggleGroup('project:orca')
      first.result.current.toggleSessionDetails('session-1')
    })

    expect(second.result.current.scope).toBe('project')
    expect(second.result.current.collapsedGroups).toEqual(new Set(['project:orca']))
    expect(second.result.current.expandedSessionIds).toEqual(new Set(['session-1']))
  })

  it('bounds disclosure state and evicts the oldest entries', () => {
    const hook = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))

    act(() => {
      for (let index = 0; index <= MAX_AI_VAULT_DISCLOSURE_STATE_ENTRIES; index += 1) {
        hook.result.current.toggleGroup(`group-${index}`)
        hook.result.current.toggleSessionDetails(`session-${index}`)
      }
    })

    expect(hook.result.current.collapsedGroups.size).toBe(MAX_AI_VAULT_DISCLOSURE_STATE_ENTRIES)
    expect(hook.result.current.collapsedGroups.has('group-0')).toBe(false)
    expect(
      hook.result.current.collapsedGroups.has(`group-${MAX_AI_VAULT_DISCLOSURE_STATE_ENTRIES}`)
    ).toBe(true)
    expect(hook.result.current.expandedSessionIds.size).toBe(MAX_AI_VAULT_DISCLOSURE_STATE_ENTRIES)
    expect(hook.result.current.expandedSessionIds.has('session-0')).toBe(false)
    expect(
      hook.result.current.expandedSessionIds.has(`session-${MAX_AI_VAULT_DISCLOSURE_STATE_ENTRIES}`)
    ).toBe(true)
  })

  it('returns to defaults when the renderer-session cache resets', () => {
    const first = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))
    act(() => {
      first.result.current.selectScope('all')
      first.result.current.toggleGroup('project:orca')
      first.result.current.toggleSessionDetails('session-1')
    })
    first.unmount()

    clearAiVaultPanelTransientStateForTests()
    const freshSession = renderHook(() => useAiVaultPanelTransientState(AVAILABLE_CONTEXT))
    expect(freshSession.result.current.scope).toBe('workspace')
    expect(freshSession.result.current.collapsedGroups).toEqual(new Set())
    expect(freshSession.result.current.expandedSessionIds).toEqual(new Set())
  })
})
