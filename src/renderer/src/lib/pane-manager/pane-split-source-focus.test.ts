// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DragReorderCallbacks } from './pane-drag-reorder'
import type { ManagedPaneInternal } from './pane-manager-types'

const applyPaneOpacity = vi.hoisted(() => vi.fn())

vi.mock('./pane-tree-ops', () => ({
  captureScrollState: vi.fn(),
  findPaneChildren: vi.fn(),
  promoteSibling: vi.fn(),
  removeDividers: vi.fn(),
  safeFit: vi.fn(),
  wrapInSplit: vi.fn()
}))
vi.mock('./pane-lifecycle', () => ({ disposePane: vi.fn(), openTerminal: vi.fn() }))
vi.mock('./pane-webgl-renderer', () => ({ disposeWebgl: vi.fn() }))
vi.mock('./pane-split-scroll', () => ({
  clearPendingSplitScrollRestore: vi.fn(),
  scheduleSplitScrollRestore: vi.fn()
}))
vi.mock('./pane-drag-reorder', () => ({ updateMultiPaneState: vi.fn() }))
vi.mock('./pane-divider', () => ({ applyDividerStyles: vi.fn(), applyPaneOpacity }))

import { splitManagedPane } from './pane-split-close'

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function createPane(id: number): ManagedPaneInternal {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = String(id)
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  container.append(textarea)
  const pane = { id, leafId: `leaf-${id}`, terminal: { focus: vi.fn() }, container }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: splitManagedPane reads only id, leafId, container and terminal.focus once its collaborators are mocked.
  return pane as unknown as ManagedPaneInternal
}

function splitWithoutFocusing(
  focusedElement: (source: HTMLElement) => HTMLElement | null,
  initialActivePaneId = 1
) {
  const root = document.createElement('div')
  const source = createPane(1)
  const created = createPane(2)
  root.append(source.container)
  document.body.append(root)
  focusedElement(source.container)?.focus()
  const panes = new Map([[source.id, source]])
  let activePaneId = initialActivePaneId
  const setActivePaneId = vi.fn((id: number | null) => {
    activePaneId = id ?? initialActivePaneId
  })
  const publishPaneCreated = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: updateMultiPaneState is mocked, so the callbacks are never read.
  const dragCallbacks = {} as DragReorderCallbacks
  splitManagedPane({
    paneId: source.id,
    direction: 'vertical',
    opts: { focusNewPane: false },
    panes,
    root,
    styleOptions: {},
    managerOptions: { linkOpenHint: () => '' },
    createPaneInternal: () => {
      panes.set(created.id, created)
      return created
    },
    createDivider: () => document.createElement('div'),
    publishPaneCreated,
    getDragCallbacks: () => dragCallbacks,
    setActivePaneId,
    getActivePaneId: () => activePaneId,
    isDestroyed: () => false
  })
  return { source, created, setActivePaneId, publishPaneCreated, activePaneId }
}

describe('splitManagedPane with focusNewPane: false', () => {
  it('keeps the source pane active while still publishing the split', () => {
    const { source, created, setActivePaneId, publishPaneCreated } = splitWithoutFocusing(
      () => null
    )
    expect(setActivePaneId).not.toHaveBeenCalled()
    expect(applyPaneOpacity).toHaveBeenCalledWith(expect.anything(), source.id, {})
    expect(publishPaneCreated).toHaveBeenCalledWith(created, {
      placement: { kind: 'split', parentLeafId: source.leafId, direction: 'vertical' }
    })
  })

  it('activates an inactive split source without stealing focus from another input', () => {
    const input = document.createElement('input')
    document.body.append(input)
    const { source, created, activePaneId } = splitWithoutFocusing(() => input, 3)
    expect(activePaneId).toBe(source.id)
    expect(applyPaneOpacity).toHaveBeenCalledWith(expect.anything(), source.id, {})
    expect(source.terminal.focus).not.toHaveBeenCalled()
    expect(created.terminal.focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it('restores focus to the source pane when it held DOM focus', () => {
    const { source, created } = splitWithoutFocusing((container) =>
      container.querySelector('textarea')
    )
    expect(source.terminal.focus).toHaveBeenCalledOnce()
    expect(created.terminal.focus).not.toHaveBeenCalled()
  })

  it.each(['input', 'textarea'] as const)(
    'does not take focus from a non-terminal %s inside the source pane',
    (tagName) => {
      const input = document.createElement(tagName)
      const { source, created } = splitWithoutFocusing((container) => {
        container.append(input)
        return input
      })
      expect(source.terminal.focus).not.toHaveBeenCalled()
      expect(created.terminal.focus).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(input)
    }
  )

  it('does not grab focus when the source pane was not focused', () => {
    const { source, created } = splitWithoutFocusing(() => null)
    expect(source.terminal.focus).not.toHaveBeenCalled()
    expect(created.terminal.focus).not.toHaveBeenCalled()
  })
})
