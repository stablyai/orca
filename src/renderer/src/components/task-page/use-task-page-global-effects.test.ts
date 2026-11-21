// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useTaskPageGlobalEffects } from './use-task-page-global-effects'
import {
  installDiffCommentRangeDrag,
  type DiffCommentRangeDragEditor
} from '../diff-comments/diff-comment-range-drag'

type Model = Parameters<typeof useTaskPageGlobalEffects>[0]

function pressEscape(target: HTMLElement): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  )
}

function renderTaskPage(detail: Record<string, unknown>) {
  const closeTaskPage = vi.fn()
  const closeTaskDetailPage = vi.fn()
  const model = {
    closeTaskPage,
    closeTaskDetailPage,
    activeModal: 'none',
    taskSource: 'github',
    preflightStatusCurrent: true,
    preflightStatusChecked: true,
    linearStatusReady: true,
    jiraStatusReady: true,
    dialogWorkItem: null,
    selectedLinearIssue: null,
    selectedJiraIssue: null,
    newIssueOpen: false,
    newLinearIssueOpen: false,
    newJiraIssueOpen: false,
    ...detail
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields for Esc and its status refresh guards.
  renderHook(() => useTaskPageGlobalEffects(model as unknown as Model))
  const page = document.createElement('div')
  document.body.append(page)
  return { closeTaskPage, closeTaskDetailPage, page }
}

describe('useTaskPageGlobalEffects', () => {
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  it('steps back from a GitHub detail page on Escape, but not from inside a field', () => {
    const { closeTaskPage, closeTaskDetailPage, page } = renderTaskPage({
      dialogWorkItem: { id: 'issue-1', type: 'issue' }
    })
    const composer = document.createElement('textarea')
    page.append(composer)

    composer.focus()
    pressEscape(composer)
    expect(closeTaskDetailPage).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(composer)

    pressEscape(page)
    expect(closeTaskDetailPage).toHaveBeenCalledTimes(1)
    expect(closeTaskPage).not.toHaveBeenCalled()
  })

  it('steps back from a Linear detail page on Escape', () => {
    const { closeTaskPage, closeTaskDetailPage, page } = renderTaskPage({
      taskSource: 'linear',
      selectedLinearIssue: { id: 'lin-1' }
    })

    pressEscape(page)
    expect(closeTaskDetailPage).toHaveBeenCalledTimes(1)
    expect(closeTaskPage).not.toHaveBeenCalled()
  })

  it('leaves Escape to an open overlay on the list', () => {
    const { closeTaskPage, closeTaskDetailPage, page } = renderTaskPage({})
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)

    pressEscape(page)
    expect(closeTaskDetailPage).not.toHaveBeenCalled()
    expect(closeTaskPage).not.toHaveBeenCalled()

    menu.remove()
    pressEscape(page)
    expect(closeTaskPage).toHaveBeenCalledTimes(1)
  })

  it('cancels a review-comment range drag on Escape without leaving the detail page', () => {
    const { closeTaskDetailPage, page } = renderTaskPage({
      dialogWorkItem: { id: 'pr-1', type: 'pr' }
    })
    const editorDomNode = document.createElement('div')
    page.append(editorDomNode)
    const editor = {
      createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
      onDidDispose: () => ({ dispose: vi.fn() })
    }
    const drag = installDiffCommentRangeDrag({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a drag that ends by Escape before any pointermove calls only these two editor methods.
      editor: editor as unknown as DiffCommentRangeDragEditor,
      editorDomNode,
      commentableLineSet: null,
      resolvePressLine: () => 3,
      onCommit: vi.fn()
    })
    editorDomNode.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true, cancelable: true })
    )
    expect(drag.isDragging()).toBe(true)

    pressEscape(editorDomNode)
    expect(drag.isDragging()).toBe(false)
    expect(closeTaskDetailPage).not.toHaveBeenCalled()

    pressEscape(page)
    expect(closeTaskDetailPage).toHaveBeenCalledTimes(1)
    drag.dispose()
  })
})
