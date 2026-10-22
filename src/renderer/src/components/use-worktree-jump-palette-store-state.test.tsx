// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import * as promptMatch from '../../../shared/ai-vault-session-prompt-match'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { useWorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import { makeAgentEntry, makeRepo } from './worktree-jump-palette-test-fixtures'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  }
})

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

const initialAppState = useAppStore.getInitialState()

describe('useWorktreeJumpPaletteStoreState transcript identities', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialAppState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
    vi.restoreAllMocks()
  })

  it('projects legacy identities only for enabled typed search and reuses unchanged entries', () => {
    const promptCandidates = vi.spyOn(promptMatch, 'agentEntryPromptCandidates')
    const entry = makeAgentEntry('terminal', 'done', 0, { prompt: 'an existing prompt' })
    const settings = getDefaultSettings('/home/test')
    useAppStore.setState({
      agentStatusByPaneKey: { [entry.paneKey]: entry },
      settings: {
        ...settings,
        aiVaultSearch: { enabled: false, historyDays: null }
      }
    })
    const { result, rerender, unmount } = renderHook(
      ({ query }) => useWorktreeJumpPaletteStoreState({ visible: true, lingering: false, query }),
      { initialProps: { query: '' } }
    )
    rerender({ query: 'refresh' })
    expect(promptCandidates).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        settings: { ...settings, aiVaultSearch: { enabled: true, historyDays: null } }
      })
    )
    expect(promptCandidates).toHaveBeenCalledTimes(1)
    act(() => useAppStore.setState({ runtimePaneTitlesByTabId: {} }))
    act(() => useAppStore.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } }))
    expect(promptCandidates).toHaveBeenCalledTimes(1)
    const changed = { ...entry, prompt: 'a different prompt' }
    act(() => useAppStore.setState({ agentStatusByPaneKey: { [entry.paneKey]: changed } }))
    expect(promptCandidates).toHaveBeenCalledTimes(2)
    expect(result.current.transcriptAgentStatusByPaneKey[entry.paneKey]).toBe(changed)
    rerender({ query: '' })
    act(() => useAppStore.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } }))
    expect(promptCandidates).toHaveBeenCalledTimes(2)
    expect(result.current.transcriptAgentStatusByPaneKey).toEqual({})
    unmount()
    promptCandidates.mockRestore()
  })

  it('projects remote chat identities while local indexing is disabled', () => {
    const entry = makeAgentEntry('remote-chat', 'done', 0, {
      prompt: 'Remote transcript',
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'remote-session' }
    })
    useAppStore.setState({
      agentStatusByPaneKey: { [entry.paneKey]: entry },
      settings: {
        ...getDefaultSettings('/home/test'),
        aiVaultSearch: { enabled: false, historyDays: null }
      },
      repos: [{ ...makeRepo(), executionHostId: 'runtime:paired' }]
    })
    const { result, unmount } = renderHook(() =>
      useWorktreeJumpPaletteStoreState({ visible: true, lingering: false, query: '217' })
    )
    expect(result.current.transcriptAgentStatusByPaneKey[entry.paneKey]).toBe(entry)
    unmount()
  })
})
