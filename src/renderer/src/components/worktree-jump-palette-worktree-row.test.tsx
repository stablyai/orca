// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandList } from '@/components/ui/command'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Worktree } from '../../../shared/worktree/types'
import { WorktreeJumpPaletteWorktreeRow } from './worktree-jump-palette-worktree-row'
import type { WorktreePaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import type { PaletteSearchResult } from '@/lib/worktree-palette-search'
import type { PaletteActivityRank } from '@/lib/palette-match/palette-ranking'

vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))

vi.mock('@/components/repo/RepoBadgeLabel', () => ({
  RepoBadgeMark: () => <span data-repo-badge-mark="true" />
}))

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'wt-1',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeMatch(): PaletteSearchResult {
  const activity: PaletteActivityRank = { ageBucket: 0, timestamp: 0 }
  return {
    worktreeId: 'wt-1',
    matchedFields: [],
    displayNameRanges: [],
    branchRanges: [],
    repoRanges: [],
    hostRanges: [],
    supportingText: null,
    qualityClass: null,
    rank: null,
    lastActiveAt: null,
    activity
  }
}

function makeEntry(worktreeOverrides: Partial<Worktree> = {}): WorktreePaletteItem {
  return {
    id: 'entry-worktree-1',
    type: 'worktree',
    match: makeMatch(),
    worktree: makeWorktree(worktreeOverrides)
  }
}

function makeController(
  overrides: Partial<WorktreeJumpPaletteController> = {}
): WorktreeJumpPaletteController {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row only reads the fields stubbed below.
  return {
    repoMap: new Map(),
    activeWorktreeId: null,
    sshConnectionStates: new Map(),
    hostOptions: [],
    hostFilterActive: false,
    handleSelectItem: vi.fn(),
    handleToggleWorktreePinned: vi.fn(),
    activeWorkspaceExecutionHostId: null,
    hasQuery: false,
    paletteNowMs: 0,
    repoByHostIdentity: new Map(),
    ...overrides
  } as unknown as WorktreeJumpPaletteController
}

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderRow(
  worktreeOverrides: Partial<Worktree> = {},
  controllerOverrides: Partial<WorktreeJumpPaletteController> = {}
): {
  container: HTMLDivElement
  entry: WorktreePaletteItem
  controller: WorktreeJumpPaletteController
} {
  const entry = makeEntry(worktreeOverrides)
  const controller = makeController(controllerOverrides)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TooltipProvider>
        <Command>
          <CommandList>
            <WorktreeJumpPaletteWorktreeRow
              entry={entry}
              renderKey="row-1"
              controller={controller}
            />
          </CommandList>
        </Command>
      </TooltipProvider>
    )
  })
  mounted.push({ container, root })
  return { container, entry, controller }
}

function getPinToggle(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('[data-palette-pin-toggle="true"]')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Missing pin toggle button')
  }
  return button
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('WorktreeJumpPaletteWorktreeRow pin toggle', () => {
  it('renders a pin toggle reflecting the unpinned state', () => {
    const { container } = renderRow({ isPinned: false })

    const toggle = getPinToggle(container)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Pin worktree')
  })

  it('renders a pin toggle reflecting the pinned state', () => {
    const { container } = renderRow({ isPinned: true })

    const toggle = getPinToggle(container)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Unpin worktree')
  })

  it('toggles pin through the controller without navigating to the worktree', () => {
    const { container, controller } = renderRow({ id: 'wt-42', isPinned: false })

    act(() => {
      getPinToggle(container).click()
    })

    expect(controller.handleToggleWorktreePinned).toHaveBeenCalledWith('wt-42', false)
    expect(controller.handleSelectItem).not.toHaveBeenCalled()
  })

  it('still selects the worktree when the row itself is clicked outside the toggle', () => {
    const { container, entry, controller } = renderRow()

    act(() => {
      container
        .querySelector('[cmdk-item]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(controller.handleSelectItem).toHaveBeenCalledWith(entry)
  })

  it('does not select the worktree when Enter is pressed while the pin toggle has focus', () => {
    const { container, controller } = renderRow()
    const toggle = getPinToggle(container)

    act(() => {
      toggle.focus()
      toggle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })

    expect(controller.handleSelectItem).not.toHaveBeenCalled()
  })

  it('still lets arrow-key palette navigation bubble while the pin toggle has focus', () => {
    const { container } = renderRow()
    const toggle = getPinToggle(container)
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    })
    const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

    act(() => {
      toggle.focus()
      toggle.dispatchEvent(event)
    })

    // See the sibling test in worktree-jump-palette-workspace-tab-row.test.tsx for why
    // this spies on the dispatched native event rather than a DOM-ancestor listener.
    expect(stopPropagationSpy).not.toHaveBeenCalled()
  })
})
