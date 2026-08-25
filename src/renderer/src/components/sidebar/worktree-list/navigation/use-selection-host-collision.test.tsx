// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../host-section-rows'
import { useSidebarWorktreeSelection } from './use-selection'
import { getVisibleWorktreeShortcutTargets } from '../../visible-worktrees'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Selection = ReturnType<typeof useSidebarWorktreeSelection>

function row(worktree: Worktree): HostSectionRow {
  return {
    type: 'item',
    rowKey: `row:${worktree.hostId}`,
    sectionKey: 'all',
    worktree,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

const local = { id: 'shared', repoId: 'repo', hostId: 'local' } as unknown as Worktree
const remote = { id: 'shared', repoId: 'repo', hostId: 'ssh:host-b' } as unknown as Worktree
const rows = [row(local), row(remote)]
let container: HTMLDivElement
let root: Root
let selection: Selection

function Probe(): null {
  selection = useSidebarWorktreeSelection({
    sectionRows: rows,
    pinnedDisplayPolicy: 'single-location'
  })
  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Probe />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('sidebar selection host collisions', () => {
  it('publishes both rows as separate shortcut targets', () => {
    expect(getVisibleWorktreeShortcutTargets()).toEqual([
      { id: 'shared', executionHostId: 'local' },
      { id: 'shared', executionHostId: 'ssh:host-b' }
    ])
  })

  it('selects both same-id host rows independently', () => {
    const additiveEvent = {
      metaKey: navigator.userAgent.includes('Mac'),
      ctrlKey: !navigator.userAgent.includes('Mac'),
      shiftKey: false
    } as React.MouseEvent<HTMLElement>

    act(() => selection.updateSelectionForGesture(additiveEvent, local))
    act(() => selection.updateSelectionForGesture(additiveEvent, remote))

    expect(selection.selectedWorktrees.map((worktree) => worktree.hostId)).toEqual([
      'local',
      'ssh:host-b'
    ])
    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|shared', 'ssh:host-b|shared']))
  })
})
