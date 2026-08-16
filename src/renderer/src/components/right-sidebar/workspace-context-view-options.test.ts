import { describe, expect, it } from 'vitest'
import {
  createDefaultWorkspaceContextViewOptions,
  normalizeWorkspaceContextViewOptions,
  readWorkspaceContextViewOptions,
  WORKSPACE_CONTEXT_VIEW_OPTIONS_STORAGE_KEY,
  writeWorkspaceContextViewOptions
} from './workspace-context-view-options'

function memoryStorage(): {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  data: Map<string, string>
} {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    }
  }
}

describe('workspace-context-view-options', () => {
  it('round-trips through storage and drops what it does not recognise', () => {
    const storage = memoryStorage()
    writeWorkspaceContextViewOptions(
      { disabledAgents: ['codex', 'codex'], scope: 'user', section: 'mcp', showMissing: true },
      storage
    )
    expect(readWorkspaceContextViewOptions(storage)).toEqual({
      disabledAgents: ['codex'],
      scope: 'user',
      section: 'mcp',
      showMissing: true
    })
    storage.data.set(
      WORKSPACE_CONTEXT_VIEW_OPTIONS_STORAGE_KEY,
      JSON.stringify({ disabledAgents: ['not-an-agent', 'grok'], scope: 'nope', section: 3 })
    )
    expect(readWorkspaceContextViewOptions(storage)).toEqual({
      ...createDefaultWorkspaceContextViewOptions(),
      disabledAgents: ['grok']
    })
  })

  it('falls back to defaults on unreadable storage', () => {
    const storage = memoryStorage()
    storage.data.set(WORKSPACE_CONTEXT_VIEW_OPTIONS_STORAGE_KEY, '{not json')
    expect(readWorkspaceContextViewOptions(storage)).toEqual(
      createDefaultWorkspaceContextViewOptions()
    )
    expect(readWorkspaceContextViewOptions(null)).toEqual(
      createDefaultWorkspaceContextViewOptions()
    )
    expect(normalizeWorkspaceContextViewOptions(undefined)).toEqual(
      createDefaultWorkspaceContextViewOptions()
    )
  })
})
