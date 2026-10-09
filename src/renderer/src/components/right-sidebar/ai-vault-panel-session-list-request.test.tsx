// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { resolveAiVaultPanelSessionListRequest } from './ai-vault-panel-session-list-request'
import {
  writeAiVaultViewOptions,
  readAiVaultViewOptions
} from './ai-vault-view-options-persistence'

type PanelRequest = {
  scopePaths: readonly string[]
  executionHostScope: string
  sessionLimit: number | 'unlimited'
}

const panelRequests = vi.hoisted((): PanelRequest[] => [])

vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: (
    scopePaths: PanelRequest['scopePaths'],
    executionHostScope: PanelRequest['executionHostScope'],
    sessionLimit: PanelRequest['sessionLimit']
  ) => {
    panelRequests.push({ scopePaths, executionHostScope, sessionLimit })
    return {
      error: null,
      loading: false,
      refresh: vi.fn(),
      scanResult: null,
      sessions: [],
      loadedSessionLimit: null
    }
  }
}))
vi.mock('./ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: () => ({ continuationRequest: null })
}))
vi.mock('./ai-vault-original-pane-actions', () => ({
  useAiVaultOriginalPaneActions: () => ({})
}))
vi.mock('./ai-vault-session-delete-action', () => ({
  useAiVaultSessionDeleteAction: () => vi.fn()
}))
vi.mock('./AiVaultSessionVirtualList', () => ({ AiVaultSessionVirtualList: () => null }))

const WORKTREE_ID = 'repo-1::/repo/wt'

beforeEach(() => {
  panelRequests.length = 0
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree('repo-1::/repo/sibling', 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  writeAiVaultViewOptions({ ...readAiVaultViewOptions(), sessionLimit: 500 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions: vi.fn() }, ui: { writeClipboardText: vi.fn() } }
  })
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

it('builds the exact request the Session History panel sends for the active workspace', async () => {
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  render(<AiVaultPanel />)

  const request = resolveAiVaultPanelSessionListRequest(useAppStore.getState(), WORKTREE_ID)
  expect(request.scopePaths.length).toBeGreaterThan(1)
  expect(request.sessionLimit).toBe(500)
  expect(panelRequests.at(-1)).toEqual(request)
})
