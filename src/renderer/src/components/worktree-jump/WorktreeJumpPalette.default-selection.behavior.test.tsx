// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store/index'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { makeRecentTabState, makeRepo } from './worktree-jump-palette-test-fixtures'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key })
  }
})

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

const initialAppState = useAppStore.getInitialState()
let testRoot: Root

function selectedRowText(): string | undefined {
  return document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? undefined
}

// Real cmdk input and list: the Enter target is the selected option the palette renders, not a mocked value.
describe('WorktreeJumpPalette default selection', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    Element.prototype.scrollIntoView = () => {}
    useAppStore.setState(initialAppState, true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    testRoot = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => testRoot.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  // Dev builds render under StrictMode, which re-runs mount effects; the default must survive that.
  it('lands on the latest recent tab when opened with no query', async () => {
    useAppStore.setState({
      ...makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' }
      }),
      repos: [makeRepo()],
      activeModal: 'none'
    })
    await act(async () =>
      testRoot.render(
        <StrictMode>
          <WorktreeJumpPalette />
        </StrictMode>
      )
    )
    // Opened as Cmd+J does: the palette's content mounts with the modal.
    await act(async () => useAppStore.getState().openModal('worktree-palette'))

    expect(selectedRowText()).toContain('Beta chat')
  })
})
