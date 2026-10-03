// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'

const ownerMock = vi.hoisted((): { environmentId: string | null } => ({ environmentId: null }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => ownerMock.environmentId
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuCheckboxItem: ({
    checked,
    onCheckedChange,
    children
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    children?: ReactNode
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    >
      {children}
    </button>
  )
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { TerminalTabNeverHibernateMenuItem } from './TerminalTabNeverHibernateMenuItem'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TAB: TerminalTab = {
  id: 'coordinator',
  ptyId: null,
  worktreeId: 'wt-1',
  title: 'Coordinator',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function seed(options: { hibernation: boolean; neverHibernate?: boolean }): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      experimentalAgentHibernation: options.hibernation
    },
    tabsByWorktree: {
      'wt-1': [options.neverHibernate ? { ...TAB, neverHibernate: true } : TAB]
    }
  })
}

function flagInStore(): boolean | undefined {
  return useAppStore.getState().tabsByWorktree['wt-1'][0].neverHibernate
}

let container: HTMLDivElement
let root: Root

function item(): HTMLElement | null {
  return container.querySelector('[role="menuitemcheckbox"]')
}

function mount(): void {
  act(() => {
    root.render(<TerminalTabNeverHibernateMenuItem tab={TAB} />)
  })
}

beforeEach(() => {
  ownerMock.environmentId = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TerminalTabNeverHibernateMenuItem', () => {
  it('is hidden while agent hibernation is off and the tab never opted out', () => {
    seed({ hibernation: false })
    mount()
    expect(item()).toBeNull()
  })

  it('opts the tab out when checked while hibernation is on', () => {
    seed({ hibernation: true })
    mount()

    expect(item()?.textContent).toBe('Never Hibernate')
    expect(item()?.getAttribute('aria-checked')).toBe('false')
    act(() => item()!.click())

    expect(flagInStore()).toBe(true)
    expect(item()?.getAttribute('aria-checked')).toBe('true')
  })

  it('stays reachable after hibernation is switched off so the opt-out can be cleared', () => {
    seed({ hibernation: false, neverHibernate: true })
    mount()

    expect(item()?.getAttribute('aria-checked')).toBe('true')
    act(() => item()!.click())

    expect(flagInStore()).toBeUndefined()
    expect(item()).toBeNull()
  })

  it('is hidden for a tab hosted on a remote runtime, where the flag would not persist', () => {
    ownerMock.environmentId = 'env-1'
    seed({ hibernation: true })
    mount()
    expect(item()).toBeNull()
  })
})
