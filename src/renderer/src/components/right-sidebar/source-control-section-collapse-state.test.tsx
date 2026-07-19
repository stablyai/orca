// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearSourceControlSectionCollapseStateForTests,
  getSourceControlSectionCollapseStateCountForTests,
  MAX_PERSISTED_SOURCE_CONTROL_SECTION_STATES,
  seedSourceControlSectionCollapseStateForTests,
  useSourceControlSectionCollapseState,
  type SourceControlCollapsibleSectionId
} from './source-control-section-collapse-state'

let container: HTMLDivElement
let root: Root

function Probe({
  worktreeId,
  section
}: {
  worktreeId: string
  section: SourceControlCollapsibleSectionId
}): React.JSX.Element {
  const { collapsedSections, toggleSection } = useSourceControlSectionCollapseState(worktreeId)
  return (
    <button
      type="button"
      data-collapsed={collapsedSections.has(section) ? 'true' : 'false'}
      onClick={() => toggleSection(section)}
    >
      toggle
    </button>
  )
}

function renderProbe(worktreeId: string, section: SourceControlCollapsibleSectionId): void {
  act(() => root.render(<Probe worktreeId={worktreeId} section={section} />))
}

function readCollapsed(): string | null {
  return container.querySelector('button')?.getAttribute('data-collapsed') ?? null
}

function toggle(): void {
  act(() => {
    container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('useSourceControlSectionCollapseState', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    clearSourceControlSectionCollapseStateForTests()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    clearSourceControlSectionCollapseStateForTests()
  })

  it('restores a worktree section after the hook consumer remounts', () => {
    renderProbe('wt-a', 'unstaged')
    expect(readCollapsed()).toBe('false')

    toggle()
    expect(readCollapsed()).toBe('true')

    act(() => root.unmount())
    root = createRoot(container)
    renderProbe('wt-a', 'unstaged')

    expect(readCollapsed()).toBe('true')
  })

  it('isolates disclosure choices between worktrees', () => {
    renderProbe('wt-a', 'unstaged')
    toggle()
    expect(readCollapsed()).toBe('true')

    renderProbe('wt-b', 'unstaged')
    expect(readCollapsed()).toBe('false')

    renderProbe('wt-a', 'unstaged')
    expect(readCollapsed()).toBe('true')
  })

  it('keeps history collapsed by default and drops restored defaults from the cache', () => {
    renderProbe('wt-a', 'history')
    expect(readCollapsed()).toBe('true')

    toggle()
    expect(readCollapsed()).toBe('false')
    expect(getSourceControlSectionCollapseStateCountForTests()).toBe(1)

    toggle()
    expect(readCollapsed()).toBe('true')
    expect(getSourceControlSectionCollapseStateCountForTests()).toBe(0)
  })

  it('bounds non-default worktree state retained by the renderer session', () => {
    const newestIndex = MAX_PERSISTED_SOURCE_CONTROL_SECTION_STATES + 24
    for (let index = 0; index <= newestIndex; index++) {
      seedSourceControlSectionCollapseStateForTests(`wt-${index}`, new Set(['history', 'unstaged']))
    }

    expect(getSourceControlSectionCollapseStateCountForTests()).toBe(
      MAX_PERSISTED_SOURCE_CONTROL_SECTION_STATES
    )

    renderProbe('wt-0', 'unstaged')
    expect(readCollapsed()).toBe('false')
    renderProbe(`wt-${newestIndex}`, 'unstaged')
    expect(readCollapsed()).toBe('true')
  })
})
