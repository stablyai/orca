// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectCell from './ProjectCell'
import type { GitHubProjectField, GitHubProjectRow } from '../../../../shared/github-project-types'

function dispatchKey(el: HTMLElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => {
    el.dispatchEvent(event)
  })
}

function renderCell(
  dataType: 'TEXT' | 'DATE',
  onEditField: (fieldId: string, value: unknown) => void
): HTMLInputElement {
  const field = { id: 'f1', name: 'Field', dataType } as unknown as GitHubProjectField
  const row = {
    id: 'r1',
    itemType: 'ISSUE',
    fieldValuesByFieldId: {}
  } as unknown as GitHubProjectRow
  const view = render(
    <ProjectCell
      row={row}
      field={field}
      editable
      onEditField={onEditField as never}
      sourceSettings={null}
    />
  )
  const existing = view.container.querySelector('input')
  if (!existing) {
    // TEXT cells render a button until clicked into edit mode.
    fireEvent.click(view.container.querySelector('button') as HTMLButtonElement)
  }
  return view.container.querySelector('input') as HTMLInputElement
}

function runKoreanConfirm(input: HTMLInputElement, value: string): void {
  // Focus first: the date cell commits through blur(), which is inert on an unfocused element.
  act(() => input.focus())
  fireEvent.change(input, { target: { value } })
  fireEvent.compositionStart(input)
  dispatchKey(input, 'keydown', { key: 'Process', keyCode: 229, isComposing: true })
  fireEvent.compositionEnd(input, { data: '가' })
  dispatchKey(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })
  dispatchKey(input, 'keyup', { key: 'Process', keyCode: 229 })
  dispatchKey(input, 'keyup', { key: 'Enter', keyCode: 13 })
}

afterEach(cleanup)

describe('ProjectCell IME Enter ownership', () => {
  it('text cell does not commit on the recorded Korean Enter redispatch', () => {
    const onEditField = vi.fn()
    const input = renderCell('TEXT', onEditField)
    runKoreanConfirm(input, '테스')

    expect(onEditField).not.toHaveBeenCalled()
  })

  it('text cell commits on ordinary Enter', () => {
    const onEditField = vi.fn()
    const input = renderCell('TEXT', onEditField)
    fireEvent.change(input, { target: { value: 'done' } })
    dispatchKey(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })

    expect(onEditField).toHaveBeenCalled()
  })

  // Why: the date cell commits via blur() rather than calling onCommit directly, so the guard
  // has to stop the keydown before the blur is ever requested.
  it('date cell does not commit on the recorded Korean Enter redispatch', () => {
    const onEditField = vi.fn()
    const input = renderCell('DATE', onEditField)
    runKoreanConfirm(input, '2024-01-01')

    expect(onEditField).not.toHaveBeenCalled()
  })

  it('date cell commits on ordinary Enter', () => {
    const onEditField = vi.fn()
    const input = renderCell('DATE', onEditField)
    act(() => input.focus())
    fireEvent.change(input, { target: { value: '2024-01-01' } })
    dispatchKey(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })

    expect(onEditField).toHaveBeenCalled()
  })
})
