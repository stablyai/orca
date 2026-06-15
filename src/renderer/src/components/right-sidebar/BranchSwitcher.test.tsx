// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchSwitcherList } from './BranchSwitcher'
import type { BranchSwitchCandidate } from './branch-switch-candidates'

function candidate(partial: Partial<BranchSwitchCandidate>): BranchSwitchCandidate {
  return {
    refName: 'main',
    branchName: 'main',
    kind: 'local',
    isCurrent: false,
    checkedOutInWorktreeId: null,
    checkedOutInWorktreeName: null,
    ...partial
  }
}

describe('BranchSwitcherList', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderList(props: {
    candidates: BranchSwitchCandidate[]
    onSelect?: (candidate: BranchSwitchCandidate) => void
    onCreate?: (name: string) => void
  }): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <BranchSwitcherList
          query=""
          setQuery={() => {}}
          loading={false}
          candidates={props.candidates}
          onSelect={props.onSelect ?? (() => {})}
          onCreate={props.onCreate ?? (() => {})}
        />
      )
    })
  }

  function findByText(text: string): Element | undefined {
    return Array.from(container.querySelectorAll('*')).find((node) =>
      Array.from(node.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim() === text
      )
    )
  }

  it('invokes onSelect for a normal branch', () => {
    const onSelect = vi.fn()
    renderList({ candidates: [candidate({ branchName: 'main' })], onSelect })

    const row = findByText('main')
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ branchName: 'main' }))
  })

  it('shows the workspace hint for a branch checked out elsewhere', () => {
    renderList({
      candidates: [
        candidate({
          branchName: 'hotfix',
          checkedOutInWorktreeId: 'ws-2',
          checkedOutInWorktreeName: 'hotfix-ws'
        })
      ]
    })

    expect(container.textContent).toContain('hotfix-ws')
  })
})
