// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import CodexRestartChip from './CodexRestartChip'
import { useAppStore } from '../store'
import type { TerminalTab } from '../../../shared/types'

describe('CodexRestartChip render behavior', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount()
      })
    }
    container.remove()
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('mounts hidden when a worktree has no restart notices', () => {
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            title: 'Terminal',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          } satisfies TerminalTab
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      codexRestartNoticeByPtyId: {}
    })

    expect(() => {
      act(() => {
        root.render(<CodexRestartChip worktreeId="wt-1" />)
      })
    }).not.toThrow()
    expect(container.textContent).toBe('')
  })
})
