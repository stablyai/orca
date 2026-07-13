// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import RepoMultiCombobox, { type RepoMultiComboboxGroup } from './repo-multi-combobox'

// Why: same shallow popover/command mocks as ProjectCombobox.test.tsx — the
// grouped-section logic under test lives in RepoMultiCombobox itself, not in
// Radix/cmdk, and the mocks render the dropdown content unconditionally.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({
    heading,
    children
  }: {
    heading?: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      <div data-command-group-heading="">{heading}</div>
      {children}
    </div>
  ),
  CommandInput: ({
    onValueChange,
    value,
    ...props
  }: {
    onValueChange?: (value: string) => void
    value?: string
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      data-testid="repo-search"
      value={value}
      onChange={(event) => onValueChange?.(event.target.value)}
      {...props}
    />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    onSelect,
    value,
    disabled
  }: {
    children: React.ReactNode
    onSelect?: (value: string) => void
    value: string
    disabled?: boolean
  }) => (
    <button
      type="button"
      data-command-value={value}
      disabled={disabled}
      onClick={() => onSelect?.(value)}
    >
      {children}
    </button>
  )
}))

function repo(id: string, displayName: string): Repo {
  return { id, displayName, path: `/repos/${id}`, badgeColor: '#111111', addedAt: 1 }
}

const repos = [repo('r1', 'Dashboard'), repo('r2', 'Docs'), repo('r3', 'API')]
const groups: RepoMultiComboboxGroup[] = [
  { id: 'g1', name: 'Platform', repoIds: ['r1', 'r2'] },
  // 'ghost' is not offered by the picker and must not count or be selected.
  { id: 'g2', name: 'Demo', repoIds: ['r3', 'ghost'] }
]

let container: HTMLDivElement
let root: Root

function renderCombobox(props: {
  selected?: ReadonlySet<string>
  groups?: RepoMultiComboboxGroup[]
  onChange?: (next: ReadonlySet<string>) => void
}): void {
  act(() => {
    root.render(
      <RepoMultiCombobox
        repos={repos}
        selected={props.selected ?? new Set()}
        onChange={props.onChange ?? (() => {})}
        onSelectAll={() => {}}
        groups={props.groups}
      />
    )
  })
}

function clickGroupRow(groupId: string): void {
  act(() => {
    container
      .querySelector<HTMLButtonElement>(`[data-command-value="group:${groupId}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('RepoMultiCombobox groups section', () => {
  it('renders Groups and Projects headings with per-group counts', () => {
    renderCombobox({ groups })

    const headings = Array.from(
      container.querySelectorAll('[data-command-group-heading]'),
      (node) => node.textContent
    )
    expect(headings).toEqual(['Groups', 'Projects'])
    const platformRow = container.querySelector('[data-command-value="group:g1"]')
    expect(platformRow?.textContent).toContain('Platform')
    expect(platformRow?.textContent).toContain('2 projects')
    // Demo's unknown repo id is excluded by the intersection with the picker's repos.
    expect(container.querySelector('[data-command-value="group:g2"]')?.textContent).toContain(
      '1 projects'
    )
  })

  it('keeps group-less pickers flat: no headings, no group rows', () => {
    renderCombobox({})

    expect(container.querySelector('[data-command-group-heading]')).toBeNull()
    expect(container.querySelector('[data-command-value^="group:"]')).toBeNull()
    expect(container.querySelector('[data-command-value="r1"]')).not.toBeNull()
  })

  it('selects every pickable repo of a group through the rendered row', () => {
    const onChange = vi.fn()
    renderCombobox({ groups, onChange })

    clickGroupRow('g1')

    expect(onChange).toHaveBeenCalledWith(new Set(['r1', 'r2']))
  })

  it('deselects a fully-selected group but blocks emptying the selection', () => {
    const onChange = vi.fn()
    renderCombobox({ groups, selected: new Set(['r1', 'r2', 'r3']), onChange })
    clickGroupRow('g1')
    expect(onChange).toHaveBeenCalledWith(new Set(['r3']))

    onChange.mockClear()
    renderCombobox({ groups, selected: new Set(['r1', 'r2']), onChange })
    clickGroupRow('g1')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('mirrors child selection on group rows: none, partial minus with count, all check', () => {
    renderCombobox({ groups, selected: new Set(['r1']) })

    const platformIndicator = container.querySelector(
      '[data-command-value="group:g1"] [data-group-selection-state]'
    )
    expect(platformIndicator?.getAttribute('data-group-selection-state')).toBe('partial')
    expect(container.querySelector('[data-command-value="group:g1"]')?.textContent).toContain(
      '1/2 projects'
    )
    expect(
      container
        .querySelector('[data-command-value="group:g2"] [data-group-selection-state]')
        ?.getAttribute('data-group-selection-state')
    ).toBe('none')

    renderCombobox({ groups, selected: new Set(['r1', 'r2']) })
    const fullIndicator = container.querySelector(
      '[data-command-value="group:g1"] [data-group-selection-state]'
    )
    expect(fullIndicator?.getAttribute('data-group-selection-state')).toBe('all')
    expect(container.querySelector('[data-command-value="group:g1"]')?.textContent).toContain(
      '2 projects'
    )
  })

  it('filters group rows by the search query', () => {
    renderCombobox({ groups })

    act(() => {
      const input = container.querySelector<HTMLInputElement>('[data-testid="repo-search"]')
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, 'plat')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.querySelector('[data-command-value="group:g1"]')).not.toBeNull()
    expect(container.querySelector('[data-command-value="group:g2"]')).toBeNull()
  })
})
