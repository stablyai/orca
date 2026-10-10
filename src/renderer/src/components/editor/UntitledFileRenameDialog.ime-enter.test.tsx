// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireImeConfirmEnter, firePlainEnter } from '@/lib/ime-enter-confirm-test-fixture'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'

afterEach(cleanup)

describe('UntitledFileRenameDialog Enter', () => {
  it('ignores the Enter that confirms an IME composition in both fields', () => {
    const onConfirm = vi.fn()
    render(
      <UntitledFileRenameDialog
        open
        currentName="Untitled-1.md"
        worktreePath="/repo"
        onClose={() => {}}
        onConfirm={onConfirm}
      />
    )
    const nameInput = screen.getByPlaceholderText('file name')
    const folderInput = screen.getByDisplayValue('/repo')

    fireImeConfirmEnter(nameInput)
    fireImeConfirmEnter(folderInput)
    expect(onConfirm).not.toHaveBeenCalled()

    firePlainEnter(nameInput)
    expect(onConfirm).toHaveBeenCalledWith('Untitled-1.md')
  })
})
