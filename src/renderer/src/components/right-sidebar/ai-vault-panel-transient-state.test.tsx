// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useAiVaultPanelScope as useScope } from './use-ai-vault-panel-scope'

let useAiVaultPanelScope: typeof useScope

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

beforeEach(async () => {
  vi.resetModules()
  useAiVaultPanelScope = (await import('./use-ai-vault-panel-scope')).useAiVaultPanelScope
})
afterEach(cleanup)

describe('useAiVaultPanelScope', () => {
  it('restores scope and collapsed groups when the panel remounts', () => {
    const first = renderHook(() => useAiVaultPanelScope(AVAILABLE_CONTEXT))

    act(() => {
      first.result.current.selectScope('project')
      first.result.current.toggleGroup('project:orca')
    })
    first.unmount()

    const restored = renderHook(() => useAiVaultPanelScope(AVAILABLE_CONTEXT))
    expect(restored.result.current.scope).toBe('project')
    expect(restored.result.current.collapsedGroups).toEqual(new Set(['project:orca']))
  })

  it('falls back to all without forgetting a preferred project scope', () => {
    const first = renderHook((context: AiVaultPanelContext) => useAiVaultPanelScope(context), {
      initialProps: AVAILABLE_CONTEXT
    })
    act(() => first.result.current.selectScope('project'))
    first.unmount()

    const restored = renderHook((context: AiVaultPanelContext) => useAiVaultPanelScope(context), {
      initialProps: UNAVAILABLE_PROJECT_CONTEXT
    })
    expect(restored.result.current.scope).toBe('all')

    restored.rerender(AVAILABLE_CONTEXT)
    expect(restored.result.current.scope).toBe('project')
  })

  it('restores the default workspace scope after an unavailable-context remount', () => {
    const first = renderHook((context: AiVaultPanelContext) => useAiVaultPanelScope(context), {
      initialProps: AVAILABLE_CONTEXT
    })
    expect(first.result.current.scope).toBe('workspace')

    first.rerender(UNAVAILABLE_WORKSPACE_CONTEXT)
    expect(first.result.current.scope).toBe('all')
    first.unmount()

    const restored = renderHook((context: AiVaultPanelContext) => useAiVaultPanelScope(context), {
      initialProps: UNAVAILABLE_WORKSPACE_CONTEXT
    })
    expect(restored.result.current.scope).toBe('all')

    restored.rerender(AVAILABLE_CONTEXT)
    expect(restored.result.current.scope).toBe('workspace')
  })

  it('keeps an explicit all scope sticky across context changes and remounts', () => {
    const first = renderHook(() => useAiVaultPanelScope(AVAILABLE_CONTEXT))
    act(() => first.result.current.selectScope('all'))
    first.unmount()

    const restored = renderHook(() =>
      useAiVaultPanelScope({ activeProjectKey: null, activeWorktreePath: null })
    )
    expect(restored.result.current.scope).toBe('all')
    restored.unmount()

    const availableAgain = renderHook(() => useAiVaultPanelScope(AVAILABLE_CONTEXT))
    expect(availableAgain.result.current.scope).toBe('all')
  })

  it('bounds collapsed groups and evicts the oldest entries', () => {
    const hook = renderHook(() => useAiVaultPanelScope(AVAILABLE_CONTEXT))

    act(() => {
      for (let index = 0; index <= 512; index += 1) {
        hook.result.current.toggleGroup(`group-${index}`)
      }
    })

    expect(hook.result.current.collapsedGroups.size).toBe(512)
    expect(hook.result.current.collapsedGroups.has('group-0')).toBe(false)
    expect(hook.result.current.collapsedGroups.has('group-512')).toBe(true)

    act(() => hook.result.current.toggleGroup('group-512'))
    expect(hook.result.current.collapsedGroups.size).toBe(511)
    expect(hook.result.current.collapsedGroups.has('group-512')).toBe(false)
    act(() => hook.result.current.toggleGroup('group-512'))
    expect(hook.result.current.collapsedGroups.size).toBe(512)
    expect(hook.result.current.collapsedGroups.has('group-1')).toBe(true)
    expect(hook.result.current.collapsedGroups.has('group-512')).toBe(true)
  })

  it('keeps a dialog local without inheriting or changing sidebar choices', () => {
    const sidebar = renderHook(() => useAiVaultPanelScope(AVAILABLE_CONTEXT))
    act(() => {
      sidebar.result.current.handleScopeChange('project')
      sidebar.result.current.toggleGroup('project:orca')
    })
    const dialog = renderHook(() => useAiVaultPanelScope({ ...AVAILABLE_CONTEXT, local: true }))
    expect(dialog.result.current.scope).toBe('workspace')
    expect(dialog.result.current.collapsedGroups.size).toBe(0)
    act(() => {
      dialog.result.current.handleScopeChange('all')
      dialog.result.current.toggleGroup('project:dialog')
    })
    expect(sidebar.result.current.scope).toBe('project')
    expect(sidebar.result.current.collapsedGroups).toEqual(new Set(['project:orca']))
    dialog.unmount()
    const reopened = renderHook(() => useAiVaultPanelScope({ ...AVAILABLE_CONTEXT, local: true }))
    expect(reopened.result.current.scope).toBe('workspace')
    expect(reopened.result.current.collapsedGroups.size).toBe(0)
    sidebar.unmount()
    const returned = renderHook(() => useAiVaultPanelScope(AVAILABLE_CONTEXT))
    expect(returned.result.current.scope).toBe('project')
    expect(returned.result.current.collapsedGroups).toEqual(new Set(['project:orca']))
  })
})
