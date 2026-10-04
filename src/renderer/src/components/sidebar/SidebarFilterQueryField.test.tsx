// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import SidebarFilterQueryField from './SidebarFilterQueryField'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let root: Root
const updateSettings = vi.fn().mockResolvedValue(undefined)

function makeWorktree(id: string, branch: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    head: 'abc',
    branch: `refs/heads/${branch}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 0
}

function input(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>('input[role="combobox"]')
  if (!element) {
    throw new Error('filter input missing')
  }
  return element
}

function setValue(value: string): void {
  const element = input()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { 'repo-1': [makeWorktree('alpha', 'main'), makeWorktree('beta', 'fix/x')] },
    sidebarFilterQuery: '',
    sidebarFilterMatchCount: null,
    updateSettings
  })
  act(() => {
    root.render(
      <TooltipProvider>
        <SidebarFilterQueryField />
      </TooltipProvider>
    )
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  updateSettings.mockClear()
})

describe('SidebarFilterQueryField', () => {
  it('writes typed text to the store query', () => {
    setValue('host:')
    expect(useAppStore.getState().sidebarFilterQuery).toBe('host:')
  })

  it('offers qualifier keys while typing a bare word and inserts the chosen one', () => {
    act(() => input().focus())
    setValue('bra')
    const options = [...container.querySelectorAll('[role="option"]')].map((el) =>
      el.textContent?.trim()
    )
    expect(options[0]).toContain('branch:')
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(useAppStore.getState().sidebarFilterQuery).toBe('branch:')
  })

  it('suggests known branches after the qualifier colon', () => {
    act(() => input().focus())
    setValue('branch:fi')
    const options = [...container.querySelectorAll('[role="option"]')].map((el) =>
      el.textContent?.trim()
    )
    expect(options).toEqual(['fix/x'])
  })

  it('shows the match counter published by the list and clears on Escape', () => {
    setValue('alpha')
    act(() => useAppStore.setState({ sidebarFilterMatchCount: 1 }))
    expect(container.textContent).toContain('1 / 2')
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(useAppStore.getState().sidebarFilterQuery).toBe('')
  })
})
