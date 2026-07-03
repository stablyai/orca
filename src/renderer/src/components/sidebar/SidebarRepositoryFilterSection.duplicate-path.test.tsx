// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Repo } from '../../../../shared/types'
import SidebarRepositoryFilterSection from './SidebarRepositoryFilterSection'

const mocks = vi.hoisted(() => ({
  filterRepoIds: [] as string[],
  repos: [] as Repo[],
  setFilterRepoIds: (ids: string[]) => {
    void ids
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) =>
    selector({
      filterRepoIds: mocks.filterRepoIds,
      setFilterRepoIds: mocks.setFilterRepoIds,
      repos: mocks.repos
    } as Partial<AppState>)
}))

// cmdk relies on layout APIs happy-dom lacks; the row markup is what we assert.
vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandInput: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => <input ref={ref} {...props} />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    onSelect,
    value
  }: {
    children: React.ReactNode
    onSelect?: (value: string) => void
    value: string
  }) => (
    <button type="button" data-command-value={value} onClick={() => onSelect?.(value)}>
      {children}
    </button>
  )
}))

function repo(id: string, displayName: string, path: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path,
    displayName,
    badgeColor: '#111111',
    addedAt: 1,
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.filterRepoIds = []
  mocks.repos = []
  mocks.setFilterRepoIds = vi.fn((ids: string[]) => {
    mocks.filterRepoIds = ids
  })
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

function pathSubtitleFor(repoId: string): string | undefined {
  const row = container.querySelector<HTMLButtonElement>(`[data-command-value="${repoId}"]`)
  return row?.querySelector('p')?.textContent ?? undefined
}

describe('SidebarRepositoryFilterSection same-name path subtitle', () => {
  it('shows the path subtitle for same-named available rows and hides it for unique names', () => {
    mocks.repos = [
      repo('dup-a', 'merchant', '/work/oneship/merchant'),
      repo('dup-b', 'merchant', '/work/payments/merchant'),
      repo('unique', 'orca', '/work/orca')
    ]

    act(() => {
      root.render(<SidebarRepositoryFilterSection />)
    })

    expect(pathSubtitleFor('dup-a')).toBe('/work/oneship/merchant')
    expect(pathSubtitleFor('dup-b')).toBe('/work/payments/merchant')
    // Unique name → no disambiguating subtitle, keeping the row compact.
    expect(pathSubtitleFor('unique')).toBeUndefined()
  })

  it('keeps the surviving row path when its same-named sibling is already selected', () => {
    // Why: the duplicate set must come from the full repos slice, not the
    // rendered available subset. The selected sibling moves into a path-less
    // pill and leaves availableRepos, so a set derived from availableRepos would
    // re-hide the survivor's disambiguator — the exact multi-select flow #6235
    // targets. With dup-a pre-selected, dup-b is the only available "merchant"
    // row yet must still show its path because dup-a is still in `repos`.
    mocks.filterRepoIds = ['dup-a']
    mocks.repos = [
      repo('dup-a', 'merchant', '/work/oneship/merchant'),
      repo('dup-b', 'merchant', '/work/payments/merchant')
    ]

    act(() => {
      root.render(<SidebarRepositoryFilterSection />)
    })

    // dup-a is a selected pill (no longer an available row); dup-b survives and
    // must still show its path even though it is now the only "merchant" row.
    expect(container.querySelector('[data-command-value="dup-a"]')).toBeNull()
    expect(pathSubtitleFor('dup-b')).toBe('/work/payments/merchant')
  })
})
