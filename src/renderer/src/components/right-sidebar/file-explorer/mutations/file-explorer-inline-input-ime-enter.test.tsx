// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { InlineInputRow } from './file-explorer-inline-input-row'
import type { InlineInput } from './file-explorer-inline-input-row'

const newFileInput: InlineInput = {
  parentPath: '/repo/src',
  type: 'file',
  depth: 1
}

// Mount focus needs one frame; input arms after the 200ms menu-close grace period.
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

async function settleInlineInput(): Promise<void> {
  await advance(0)
  await advance(250)
}

function renderNewFileRow(): {
  input: HTMLElement
  onSubmit: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  rerenderWith: (inlineInput: InlineInput) => HTMLElement
} {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  const renderRow = (inlineInput: InlineInput): React.JSX.Element => (
    <InlineInputRow depth={1} inlineInput={inlineInput} onSubmit={onSubmit} onCancel={onCancel} />
  )
  const view = render(renderRow(newFileInput))
  const rerenderWith = (inlineInput: InlineInput): HTMLElement => {
    view.rerender(renderRow(inlineInput))
    return view.getByRole('textbox')
  }
  return { input: view.getByRole('textbox'), onSubmit, onCancel, rerenderWith }
}

describe('file explorer inline input with an IME', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('drops composition ownership when a keyed remount skips blur', async () => {
    const { input, onSubmit, rerenderWith } = renderNewFileRow()
    await settleInlineInput()
    fireEvent.compositionStart(input)

    const remountedInput = rerenderWith({
      parentPath: '/repo/src',
      type: 'rename',
      depth: 1,
      existingName: 'notes.md',
      existingPath: '/repo/src/notes.md'
    })
    await settleInlineInput()
    fireEvent.keyDown(remountedInput, { key: 'Enter', keyCode: 13 })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('notes.md')
  })
})
