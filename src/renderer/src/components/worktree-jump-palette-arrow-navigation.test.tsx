// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import {
  CREATE_WORKTREE_ITEM_ID,
  getNextWorktreePaletteSelection,
  getWorktreePaletteSelectionItemIds
} from '@/lib/worktree-palette-create-action'

type Entry = { id: string; type: string }

// Why: mirrors WorktreeJumpPalette's controlled-value wiring exactly (loop,
// shouldFilter=false, value from getNextWorktreePaletteSelection, headers/hints
// as plain divs). The bug lives in that handshake, not in either half alone —
// the pure function is correct in isolation even while arrow keys are broken.
function PaletteHarness({
  entries,
  onSelect,
  showCreateAction = false
}: {
  entries: readonly Entry[]
  onSelect?: (id: string) => void
  showCreateAction?: boolean
}): React.JSX.Element {
  const [selectedItemId, setSelectedItemId] = useState('')
  const selectionItemIds = getWorktreePaletteSelectionItemIds(entries)
  const commandSelectedItemId = getNextWorktreePaletteSelection({
    currentSelectedItemId: selectedItemId,
    queryChanged: false,
    selectableItemIds: selectionItemIds,
    showCreateAction
  })

  return (
    <Command
      loop
      shouldFilter={false}
      value={commandSelectedItemId}
      onValueChange={setSelectedItemId}
    >
      <CommandList>
        {entries.map((entry) => {
          if (entry.type === 'section-header' || entry.type === 'hint') {
            return <div key={entry.id}>{entry.id}</div>
          }
          return (
            <CommandItem key={entry.id} value={entry.id} onSelect={() => onSelect?.(entry.id)}>
              {entry.id}
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}

function selectedId(container: HTMLElement): string | null {
  return container.querySelector('[cmdk-item=""][aria-selected="true"]')?.textContent ?? null
}

function press(container: HTMLElement, key: string): void {
  fireEvent.keyDown(container.querySelector('[cmdk-root=""]') as HTMLElement, { key })
}

// Two worktrees matter: stepping onto the *second* one changes the controlled
// value prop, which is what arms cmdk's re-sync effect on the next ArrowDown.
const WORKTREES_THEN_TABS: Entry[] = [
  { id: '__header_worktrees__', type: 'section-header' },
  { id: 'worktree:one', type: 'worktree' },
  { id: 'worktree:two', type: 'worktree' },
  { id: '__header_open_tabs__', type: 'section-header' },
  { id: 'workspace-tab:term', type: 'workspace-tab' },
  { id: 'simulator-tab:sim', type: 'simulator-tab' }
]

describe('worktree jump palette arrow navigation', () => {
  afterEach(cleanup)

  it('crosses from the last worktree into the first open tab on ArrowDown', () => {
    const { container } = render(<PaletteHarness entries={WORKTREES_THEN_TABS} />)

    expect(selectedId(container)).toBe('worktree:one')
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('worktree:two')
    // The regression: this step used to snap back to the first worktree.
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('workspace-tab:term')
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('simulator-tab:sim')
  })

  it('crosses back from the first open tab into the last worktree on ArrowUp', () => {
    const { container } = render(<PaletteHarness entries={WORKTREES_THEN_TABS} />)

    press(container, 'ArrowDown')
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('workspace-tab:term')
    press(container, 'ArrowUp')
    expect(selectedId(container)).toBe('worktree:two')
    press(container, 'ArrowUp')
    expect(selectedId(container)).toBe('worktree:one')
  })

  it('wraps at both ends', () => {
    const { container } = render(<PaletteHarness entries={WORKTREES_THEN_TABS} />)

    press(container, 'ArrowUp')
    expect(selectedId(container)).toBe('simulator-tab:sim')
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('worktree:one')
  })

  it('activates the row that is highlighted', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <PaletteHarness entries={WORKTREES_THEN_TABS} onSelect={onSelect} />
    )

    press(container, 'ArrowDown')
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('workspace-tab:term')
    press(container, 'Enter')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('workspace-tab:term')
  })

  it('steps onto every row type without stalling', () => {
    const { container } = render(
      <PaletteHarness
        showCreateAction
        entries={[
          { id: 'worktree:one', type: 'worktree' },
          { id: 'project-target:orca', type: 'project-target' },
          { id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' },
          { id: 'settings:provider', type: 'settings' },
          { id: 'quick-action:new-terminal', type: 'quick-action' },
          { id: 'workspace-tab:term', type: 'workspace-tab' },
          { id: 'simulator-tab:sim', type: 'simulator-tab' },
          { id: 'browser-page:one', type: 'browser-page' }
        ]}
      />
    )

    const visited = ['worktree:one']
    for (let i = 0; i < 7; i++) {
      press(container, 'ArrowDown')
      visited.push(selectedId(container) as string)
    }

    expect(visited).toEqual([
      'worktree:one',
      'project-target:orca',
      CREATE_WORKTREE_ITEM_ID,
      'settings:provider',
      'quick-action:new-terminal',
      'workspace-tab:term',
      'simulator-tab:sim',
      'browser-page:one'
    ])
  })

  it('skips headers and hint rows', () => {
    const { container } = render(
      <PaletteHarness
        entries={[
          { id: '__header_worktrees__', type: 'section-header' },
          { id: 'worktree:one', type: 'worktree' },
          { id: '__hint_worktree_cap__', type: 'hint' },
          { id: '__header_open_tabs__', type: 'section-header' },
          { id: 'workspace-tab:term', type: 'workspace-tab' }
        ]}
      />
    )

    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('workspace-tab:term')
  })

  it('navigates when only open tabs are present', () => {
    const { container } = render(
      <PaletteHarness
        entries={[
          { id: '__header_open_tabs__', type: 'section-header' },
          { id: 'workspace-tab:term', type: 'workspace-tab' },
          { id: 'simulator-tab:sim', type: 'simulator-tab' }
        ]}
      />
    )

    expect(selectedId(container)).toBe('workspace-tab:term')
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('simulator-tab:sim')
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('workspace-tab:term')
  })

  it('keeps a lone tab row selected through arrow presses', () => {
    const { container } = render(
      <PaletteHarness entries={[{ id: 'workspace-tab:term', type: 'workspace-tab' }]} />
    )

    expect(selectedId(container)).toBe('workspace-tab:term')
    press(container, 'ArrowDown')
    expect(selectedId(container)).toBe('workspace-tab:term')
    press(container, 'ArrowUp')
    expect(selectedId(container)).toBe('workspace-tab:term')
  })

  it('scrolls the newly selected row into view when crossing a section boundary', () => {
    const scrollIntoView = vi.fn()
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)

    const { container } = render(<PaletteHarness entries={WORKTREES_THEN_TABS} />)
    press(container, 'ArrowDown')
    press(container, 'ArrowDown')

    expect(selectedId(container)).toBe('workspace-tab:term')
    expect(scrollIntoView).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
