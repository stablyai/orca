// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { boundHostList } from './bounded-host-list'
import { HostListSearchField } from './HostListSearchField'

function host(label: string): { id: string; label: string } {
  return { id: label, label }
}

afterEach(() => {
  cleanup()
})

describe('boundHostList', () => {
  it('ranks an exact name first, then prefixes, then substrings or search text', () => {
    const hosts = [
      host('east-prod'),
      host('prod-2'),
      { ...host('db'), searchText: 'prod database' },
      host('PROD')
    ]
    expect(boundHostList(hosts, { query: ' prod ' }).shown.map((h) => h.id)).toEqual([
      'PROD',
      'prod-2',
      'east-prod',
      'db'
    ])
  })

  it('gives matches their own limit so a full pinned set never hides a search result', () => {
    const hosts = Array.from({ length: 80 }, (_, i) => host(`h-${i}`))
    const pinnedIds = new Set(hosts.slice(0, 60).map((h) => h.id))
    const { shown, hiddenCount } = boundHostList(hosts, { query: 'h-79', pinnedIds, limit: 50 })
    expect(shown.map((h) => h.id)).toEqual(['h-79'])
    expect(hiddenCount).toBe(0)
    const all = boundHostList(hosts, { pinnedIds, limit: 50 })
    expect(all.shown).toHaveLength(70)
    expect(all.hiddenCount).toBe(10)
  })

  it('ranks pinned matches too, so an exact pinned name survives a long pinned set', () => {
    const hosts = [...Array.from({ length: 60 }, (_, i) => host(`node-${i}-prod`)), host('prod')]
    const pinnedIds = new Set(hosts.map((h) => h.id))
    const { shown } = boundHostList(hosts, { query: 'prod', pinnedIds, limit: 50 })
    expect(shown[0]?.id).toBe('prod')
  })

  it('keeps input order when not searching, so a row never jumps when it is pinned', () => {
    const { shown } = boundHostList([host('local'), host('a'), host('b')], {
      pinnedIds: new Set(['b'])
    })
    expect(shown.map((h) => h.id)).toEqual(['local', 'a', 'b'])
  })

  it('narrows pinned hosts by the query too', () => {
    const { shown } = boundHostList([host('a1'), host('b1')], {
      query: 'b',
      pinnedIds: new Set(['a1'])
    })
    expect(shown.map((h) => h.id)).toEqual(['b1'])
  })
})

describe('HostListSearchField in a menu', () => {
  it('is reached and left with arrow keys, and keeps letters out of the menu', () => {
    const onChange = vi.fn()
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem>All hosts</DropdownMenuItem>
          <HostListSearchField value="" onChange={onChange} inMenu />
          <DropdownMenuCheckboxItem checked={false}>node-1</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const search = screen.getByRole('textbox', { name: 'Search hosts…' })
    const searchItem = search.closest('[role="menuitem"]')
    expect(searchItem).toBeTruthy()
    fireEvent.focus(searchItem!)
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'n' })
    fireEvent.change(search, { target: { value: 'n' } })
    expect(onChange).toHaveBeenCalledWith('n')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('node-1')
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(document.activeElement?.textContent).toBe('All hosts')
  })
})
