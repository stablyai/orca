// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { InlineInputRow } from './FileExplorerRow'
import type { InlineInput } from './FileExplorerRow'

const renameInput: InlineInput = {
  parentPath: '/repo/src',
  type: 'rename',
  depth: 1,
  existingName: 'components',
  existingPath: '/repo/src/components'
}

const BLUR_COMMIT_MS = 200

// Why: the input focuses itself a frame after mount, then arms blur-commits once
// the 200ms menu-close grace period has elapsed.
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

function renderRenameRow(): {
  input: HTMLInputElement
  row: HTMLButtonElement
  onSubmit: ReturnType<typeof vi.fn>
} {
  const onSubmit = vi.fn()
  const view = render(
    <div>
      <InlineInputRow depth={1} inlineInput={renameInput} onSubmit={onSubmit} onCancel={vi.fn()} />
      {/* Rows are Radix context-menu triggers, so a genuine click on a neighbour
          used to be indistinguishable from Radix restoring focus after a close. */}
      <button type="button" data-slot="context-menu-trigger">
        another-file.ts
      </button>
    </div>
  )
  return {
    input: view.container.querySelector('input') as HTMLInputElement,
    row: view.container.querySelector('button') as HTMLButtonElement,
    onSubmit
  }
}

describe('file explorer inline rename input', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('commits when the user clicks another file explorer row', async () => {
    const { input, row, onSubmit } = renderRenameRow()
    await settleInlineInput()

    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.blur(input, { relatedTarget: row })
    await advance(BLUR_COMMIT_MS)

    expect(onSubmit).toHaveBeenCalledWith('renamed')
  })

  it('commits when the user tabs to another row without any pointer input', async () => {
    const { input, row, onSubmit } = renderRenameRow()
    await settleInlineInput()

    fireEvent.change(input, { target: { value: 'renamed' } })
    row.focus()
    fireEvent.blur(input, { relatedTarget: row })
    await advance(BLUR_COMMIT_MS)

    expect(onSubmit).toHaveBeenCalledWith('renamed')
  })

  it('commits when focus moves to an unrelated element', async () => {
    const { input, onSubmit } = renderRenameRow()
    await settleInlineInput()

    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.blur(input, { relatedTarget: null })
    await advance(BLUR_COMMIT_MS)

    expect(onSubmit).toHaveBeenCalledWith('renamed')
  })

  it('refocuses instead of committing when a menu close steals focus on mount', async () => {
    const { input, row, onSubmit } = renderRenameRow()
    // Only let the mount focus frame run — stay inside the grace period.
    await advance(0)

    fireEvent.blur(input, { relatedTarget: row })
    await advance(BLUR_COMMIT_MS)

    expect(onSubmit).not.toHaveBeenCalled()
  })
})
