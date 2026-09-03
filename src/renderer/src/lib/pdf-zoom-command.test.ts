// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addPdfZoomCommandListener,
  dispatchPdfZoomCommand,
  isActivePdfZoomTarget,
  type PdfZoomTargetState
} from './pdf-zoom-command'

const STATE: PdfZoomTargetState = {
  activeFileId: 'file-1',
  activeGroupIdByWorktree: { 'worktree-1': 'group-1' },
  activeWorktreeId: 'worktree-1',
  openFiles: [{ id: 'file-1', filePath: '/repo/report.pdf' }]
}

function visible(element: HTMLElement): HTMLElement {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 600 })
  return element
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('isActivePdfZoomTarget', () => {
  it('targets the PDF in the focused split group', () => {
    const group = document.createElement('div')
    group.dataset.tabGroupBodyId = 'group-1'
    group.dataset.worktreeId = 'worktree-1'
    const container = visible(document.createElement('div'))
    group.append(container)
    document.body.append(group)

    expect(isActivePdfZoomTarget(container, '/repo/report.pdf', STATE)).toBe(true)
    expect(
      isActivePdfZoomTarget(container, '/repo/report.pdf', {
        ...STATE,
        activeGroupIdByWorktree: { 'worktree-1': 'group-2' }
      })
    ).toBe(false)
    expect(isActivePdfZoomTarget(container, '/repo/other.pdf', STATE)).toBe(false)
  })

  it('uses the active file for the legacy single-pane editor', () => {
    const container = visible(document.createElement('div'))
    document.body.append(container)

    expect(isActivePdfZoomTarget(container, '/repo/report.pdf', STATE)).toBe(true)
    expect(isActivePdfZoomTarget(container, '/repo/other.pdf', STATE)).toBe(false)
  })

  it('ignores hidden PDF viewers', () => {
    expect(isActivePdfZoomTarget(document.createElement('div'), '/repo/report.pdf', STATE)).toBe(
      false
    )
  })
})

describe('PDF zoom command events', () => {
  it('reports when the active PDF claims a command', () => {
    const listener = vi.fn(() => true)
    const remove = addPdfZoomCommandListener(listener)

    expect(dispatchPdfZoomCommand('in')).toBe(true)
    expect(listener).toHaveBeenCalledWith('in')

    remove()
    expect(dispatchPdfZoomCommand('out')).toBe(false)
  })
})
