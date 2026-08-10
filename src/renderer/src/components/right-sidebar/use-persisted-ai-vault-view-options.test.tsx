// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { AI_VAULT_VIEW_OPTIONS_STORAGE_KEY } from './ai-vault-view-options-persistence'
import { usePersistedAiVaultViewOptions } from './use-persisted-ai-vault-view-options'

beforeEach(() => {
  window.localStorage.removeItem(AI_VAULT_VIEW_OPTIONS_STORAGE_KEY)
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.removeItem(AI_VAULT_VIEW_OPTIONS_STORAGE_KEY)
})

describe('usePersistedAiVaultViewOptions', () => {
  it('restores view options when the panel remounts', () => {
    const first = renderHook(() => usePersistedAiVaultViewOptions())

    act(() => {
      first.result.current.setAgentEnabled('codex', false)
      first.result.current.setSort('created')
      first.result.current.setGroup('folder')
      first.result.current.setHideEmptySessions(true)
      first.result.current.setSessionLimit('unlimited')
    })
    first.unmount()

    const restored = renderHook(() => usePersistedAiVaultViewOptions())
    expect(restored.result.current.agents).not.toContain('codex')
    expect(restored.result.current.sort).toBe('created')
    expect(restored.result.current.group).toBe('folder')
    expect(restored.result.current.hideEmptySessions).toBe(true)
    expect(restored.result.current.sessionLimit).toBe('unlimited')
  })

  it('allows clearing every agent so a single agent can be re-enabled', () => {
    const hook = renderHook(() => usePersistedAiVaultViewOptions())

    act(() => hook.result.current.setAllAgentsEnabled(false))
    expect(hook.result.current.agents).toEqual([])

    act(() => hook.result.current.setAgentEnabled('claude', true))
    expect(hook.result.current.agents).toEqual(['claude'])

    act(() => hook.result.current.setAllAgentsEnabled(true))
    expect(hook.result.current.agents).toEqual([...AI_VAULT_AGENTS])
  })

  it('allows disabling the last remaining agent', () => {
    const hook = renderHook(() => usePersistedAiVaultViewOptions())
    const lastEnabled = AI_VAULT_AGENTS[0]

    act(() => {
      for (const agent of AI_VAULT_AGENTS.slice(1)) {
        hook.result.current.setAgentEnabled(agent, false)
      }
    })
    expect(hook.result.current.agents).toEqual([lastEnabled])

    act(() => hook.result.current.setAgentEnabled(lastEnabled, false))
    expect(hook.result.current.agents).toEqual([])
  })

  it('keeps in-memory options usable when persistence fails', () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const hook = renderHook(() => usePersistedAiVaultViewOptions())

    act(() => hook.result.current.setSort('created'))

    expect(setItem).toHaveBeenCalled()
    expect(hook.result.current.sort).toBe('created')
  })

  it('resets every persisted option to its default', () => {
    const hook = renderHook(() => usePersistedAiVaultViewOptions())
    act(() => {
      hook.result.current.setAgentEnabled('codex', false)
      hook.result.current.setSort('created')
      hook.result.current.setGroup('agent')
      hook.result.current.setHideEmptySessions(true)
      hook.result.current.setSessionLimit(1000)
      hook.result.current.resetViewOptions()
    })

    expect(hook.result.current.agents).toEqual([...AI_VAULT_AGENTS])
    expect(hook.result.current.sort).toBe('updated')
    expect(hook.result.current.group).toBe('project')
    expect(hook.result.current.hideEmptySessions).toBe(false)
    expect(hook.result.current.sessionLimit).toBe(250)

    hook.unmount()
    const restored = renderHook(() => usePersistedAiVaultViewOptions())
    expect(restored.result.current.agents).toEqual([...AI_VAULT_AGENTS])
    expect(restored.result.current.sort).toBe('updated')
    expect(restored.result.current.group).toBe('project')
    expect(restored.result.current.hideEmptySessions).toBe(false)
    expect(restored.result.current.sessionLimit).toBe(250)
  })
})
