// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import WorktreeBaseFallbackDialog from './WorktreeBaseFallbackDialog'
import {
  requestWorktreeBaseFallbackNotice,
  resetWorktreeBaseFallbackNoticesForTests
} from './worktree-base-fallback-notice'

const initialState = useAppStore.getInitialState()
let root: Root | null = null

async function renderDialog(activeModal: AppState['activeModal'] = 'none'): Promise<void> {
  useAppStore.setState({
    activeModal,
    setContextualToursBlockingSurfaceVisible: vi.fn()
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<WorktreeBaseFallbackDialog />)
  })
}

describe('WorktreeBaseFallbackDialog', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    resetWorktreeBaseFallbackNoticesForTests()
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    resetWorktreeBaseFallbackNoticesForTests()
    useAppStore.setState(initialState, true)
  })

  it('waits until another app modal closes', async () => {
    requestWorktreeBaseFallbackNotice({
      requestedRef: 'origin/main',
      localRef: 'main'
    })
    await renderDialog('new-workspace-composer')

    expect(document.body.textContent).not.toContain('Workspace created from a local base')

    await act(async () => {
      useAppStore.setState({ activeModal: 'none' })
    })

    expect(document.body.textContent).toContain('Workspace created from a local base')
  })
})
