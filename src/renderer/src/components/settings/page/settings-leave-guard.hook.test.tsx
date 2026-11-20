// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  activateWorkspacesRailItem,
  navigateFromRail
} from '@/components/app-rail/app-rail-navigation'
import {
  useSettingsInteractionController,
  type SettingsInteractionModel
} from './use-settings-interaction-controller'

const initialState = useAppStore.getState()

type ConfirmOptions = { signal?: AbortSignal }
let confirmCalls: { options: ConfirmOptions; resolve: (approved: boolean) => void }[] = []
const confirm = vi.fn(
  (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      confirmCalls.push({ options, resolve })
    })
)

let setCommitDraftDirty: (dirty: boolean) => void = () => {}
let commitDraftDirty = false
let discardSignals = 0

// The real Settings interaction hook, with only the AI-prompt draft flag driven by the test.
function SettingsVisit(): null {
  const [dirty, setDirty] = useState(false)
  setCommitDraftDirty = setDirty
  commitDraftDirty = dirty
  const noop = (): void => {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the leave guard path reads only confirm, the three draft flags and their setters; the rest are inert stubs.
  const model = {
    closeSettingsPage: () => useAppStore.getState().closeSettingsPage(),
    confirm,
    hasUnsavedBranchPromptChanges: false,
    hasUnsavedChatPromptChanges: false,
    hasUnsavedCommitPromptChanges: dirty,
    highlightedSettingsTarget: null,
    setFontSuggestions: noop,
    setHasUnsavedBranchPromptChanges: noop,
    setHasUnsavedChatPromptChanges: noop,
    setHasUnsavedCommitPromptChanges: setDirty,
    setHighlightedSettingsTarget: noop,
    setSettingsSearchQuery: noop,
    setSourceControlAiPromptDiscardSignal: () => {
      discardSignals += 1
    },
    settings: null,
    updateSettingsOrThrow: async () => {}
  } as unknown as SettingsInteractionModel
  useSettingsInteractionController(model)
  return null
}

beforeEach(() => {
  confirmCalls = []
  confirm.mockClear()
  discardSignals = 0
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal worktree records; history liveness only reads id/repoId/path.
    worktreesByRepo: {
      repo1: [
        { id: 'repo1::/w/a', repoId: 'repo1', path: '/w/a' },
        { id: 'repo1::/w/b', repoId: 'repo1', path: '/w/b' }
      ]
    } as never,
    worktreeNavHistory: ['repo1::/w/a', 'repo1::/w/b'],
    worktreeNavHistoryIndex: 1,
    activeView: 'terminal',
    sidebarBody: 'workspaces',
    sidebarOpen: false
  })
  useAppStore.getState().openSettingsPage()
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

function visitSettingsThenDirtyDrafts(): void {
  render(<SettingsVisit />)
  // Dirtied after the guard registered on mount: the guard must still see it.
  act(() => setCommitDraftDirty(true))
}

// Exactly what the rail's Workspaces button runs.
function clickRailWorkspaces(): void {
  navigateFromRail(() => activateWorkspacesRailItem(useAppStore))
}

function navigationState() {
  const { activeView, worktreeNavHistory, worktreeNavHistoryIndex, sidebarOpen, sidebarBody } =
    useAppStore.getState()
  return { activeView, worktreeNavHistory, worktreeNavHistoryIndex, sidebarOpen, sidebarBody }
}

it('asks before leaving Settings for drafts dirtied after it registered, and a veto keeps everything', async () => {
  visitSettingsThenDirtyDrafts()
  const before = navigationState()

  act(() => clickRailWorkspaces())
  expect(confirm).toHaveBeenCalledTimes(1)
  await act(async () => confirmCalls[0].resolve(false))

  expect(navigationState()).toEqual(before)
  expect(before.activeView).toBe('settings')
  expect(commitDraftDirty).toBe(true)
  expect(discardSignals).toBe(0)
})

it('leaves once after approval, ignoring a second click while asking', async () => {
  visitSettingsThenDirtyDrafts()

  act(() => clickRailWorkspaces())
  act(() => clickRailWorkspaces())
  expect(confirm).toHaveBeenCalledTimes(1)
  await act(async () => confirmCalls[0].resolve(true))

  const state = navigationState()
  expect(state.activeView).toBe('terminal')
  expect(state.sidebarOpen).toBe(true)
  expect(state.worktreeNavHistoryIndex).toBe(1)
  expect(commitDraftDirty).toBe(false)
  expect(discardSignals).toBe(1)
})

it('cancels an open question when Settings unmounts and runs nothing afterwards', async () => {
  visitSettingsThenDirtyDrafts()

  act(() => clickRailWorkspaces())
  const { signal } = confirmCalls[0].options
  expect(signal?.aborted).toBe(false)
  cleanup()
  expect(signal?.aborted).toBe(true)
  await act(async () => confirmCalls[0].resolve(true))

  expect(useAppStore.getState().activeView).toBe('settings')
})
