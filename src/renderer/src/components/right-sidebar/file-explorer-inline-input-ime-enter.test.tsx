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

// Why: the input focuses itself a frame after mount, then arms itself once the
// 200ms menu-close grace period has elapsed.
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

// Why: the carry armed by a confirm Enter expires on the animation frame after keyup.
async function flushFrame(): Promise<void> {
  await advance(20)
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

  it('ignores every marked confirm Enter, then submits the full name on a plain Enter', async () => {
    const { input, onSubmit, onCancel } = renderNewFileRow()
    await settleInlineInput()

    fireEvent.change(input, { target: { value: '議事録' } })
    const markedConfirmEnters = [
      { key: 'Enter', isComposing: true },
      { key: 'Enter', isComposing: true, keyCode: 229 },
      { key: 'Enter', keyCode: 229 }
    ]
    for (const markedEnter of markedConfirmEnters) {
      fireEvent.keyDown(input, markedEnter)
      fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
      await flushFrame()
    }
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '議事録.md' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('議事録.md')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('swallows the unmarked Enter redispatched after a confirm until the carry expires', async () => {
    const { input, onSubmit } = renderNewFileRow()
    await settleInlineInput()
    fireEvent.change(input, { target: { value: '議事録' } })

    // macOS order: marked keydown, keyup, then the unmarked redispatch.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
    expect(onSubmit).not.toHaveBeenCalled()
    await flushFrame()

    // Windows/Linux order: the unmarked redispatch arrives before keyup.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
    fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
    expect(onSubmit).not.toHaveBeenCalled()
    await flushFrame()

    fireEvent.change(input, { target: { value: '議事録.md' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('議事録.md')
  })

  it('releases composition ownership on blur even when compositionend never arrives', async () => {
    const { input, onSubmit } = renderNewFileRow()
    await settleInlineInput()

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '議事録.md' } })
    fireEvent.blur(input)
    // Refocusing cancels the component's 150ms blur-commit, so only Enter can submit.
    fireEvent.focus(input)
    await advance(200)
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('議事録.md')
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

  it('cancels only on a non-composition Escape', async () => {
    const { input, onSubmit, onCancel } = renderNewFileRow()
    await settleInlineInput()

    fireEvent.change(input, { target: { value: 'ぎじろく' } })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27 })
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27 })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each(['file', 'folder', 'rename'] as const)(
    'ignores a keyCode-only confirmation and its unmarked redispatch for %s',
    async (type) => {
      const { rerenderWith, onSubmit } = renderNewFileRow()
      const input = rerenderWith({ ...newFileInput, type, existingName: 'notes.md' })
      await settleInlineInput()
      fireEvent.change(input, { target: { value: '議事録' } })
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
      fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
      expect(onSubmit).not.toHaveBeenCalled()
      await flushFrame()
      fireEvent.change(input, { target: { value: '議事録.md' } })
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('議事録.md')
    }
  )
})
