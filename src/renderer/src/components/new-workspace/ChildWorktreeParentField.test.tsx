// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import ChildWorktreeParentField from './ChildWorktreeParentField'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

function worktree(id: string, displayName: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    projectId: 'project-1',
    hostId: 'local',
    displayName,
    path: `/worktrees/${id}`,
    branch: `refs/heads/${id}`,
    head: id,
    isBare: false,
    isMainWorktree: false,
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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderField(
  overrides: Partial<React.ComponentProps<typeof ChildWorktreeParentField>> = {}
): void {
  const candidates = Array.from({ length: 6 }, (_, index) =>
    worktree(`wt-${index}`, index === 5 ? 'Payments workspace' : `Worktree ${index}`)
  )
  act(() => {
    root.render(
      <ChildWorktreeParentField
        candidates={candidates}
        enabled
        selectionSupported
        value="wt-0"
        activeWorktreeId="wt-0"
        lastVisitedAtByWorktreeId={{ 'wt-0': 60, 'wt-1': 50, 'wt-2': 40, 'wt-3': 30 }}
        onEnabledChange={vi.fn()}
        onValueChange={vi.fn()}
        {...overrides}
      />
    )
  })
}

function combobox(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]')
  if (!input) {
    throw new Error('parent combobox not found')
  }
  return input
}

function typeQuery(value: string): void {
  const input = combobox()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ChildWorktreeParentField', () => {
  it('renders a checked switch and the selected current parent', () => {
    renderField()

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(container.textContent).toContain('Make this a child worktree')
    expect(container.textContent).toContain('Group this worktree under a parent.')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    const descriptionId = toggle?.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    expect(container.querySelector(`#${descriptionId}`)?.textContent).toBe(
      'Group this worktree under a parent.'
    )
    expect(container.textContent).toContain('Worktree 0')
    expect(container.textContent).toContain('Current')
  })

  it('shows Recent before All worktrees in a blank-query list', () => {
    renderField()

    const text = container.textContent ?? ''
    expect(text.indexOf('Recent')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('All worktrees')).toBeGreaterThan(text.indexOf('Recent'))
  })

  it('exposes the committed parent as selected independently of keyboard focus', () => {
    renderField({ value: 'wt-5' })

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    const committed = rows.find((row) => row.textContent?.includes('Payments workspace'))
    const first = rows.find((row) => row.textContent?.includes('Worktree 0'))
    expect(committed?.getAttribute('aria-selected')).toBe('true')
    expect(first?.getAttribute('aria-selected')).toBe('false')
    const input = combobox()
    const label = container.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)
    expect(label?.htmlFor).toBe(input.id)
    expect(container.querySelector(`#${input.getAttribute('aria-describedby')}`)?.textContent).toBe(
      'Selected parent: Payments workspace on wt-5'
    )
    expect(input.hasAttribute('aria-valuetext')).toBe(false)
  })

  it('filters the field itself and commits a matching parent', () => {
    const onValueChange = vi.fn()
    renderField({ onValueChange })

    typeQuery('payments')
    expect(container.textContent).toContain('Payments workspace')
    expect(container.textContent).not.toContain('Worktree 1')

    const row = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (candidate) => candidate.textContent?.includes('Payments workspace')
    )
    act(() => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onValueChange).toHaveBeenCalledWith('wt-5')
  })

  it('does not commit a parent while an IME owns Enter', () => {
    const onValueChange = vi.fn()
    renderField({ onValueChange })

    const input = combobox()
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })
      )
    })

    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('reports switch changes and hides the picker while off', () => {
    const onEnabledChange = vi.fn()
    renderField({ enabled: false, value: null, onEnabledChange })

    expect(container.querySelector('[role="combobox"]')).toBeNull()
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')
    act(() => toggle?.click())
    expect(onEnabledChange).toHaveBeenCalledWith(true)
  })

  it('disables the switch when this project and host have no eligible parents', () => {
    renderField({ candidates: [], enabled: false, value: null })

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.disabled).toBe(true)
    expect(container.textContent).toContain(
      'No eligible parent worktrees on this project and host.'
    )
  })

  it('keeps the field visible but disabled when the connected server needs an update', () => {
    renderField({ enabled: false, selectionSupported: false })

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.disabled).toBe(true)
    expect(container.textContent).toContain(
      'Update the connected Orca server to choose a child worktree parent.'
    )
  })
})
