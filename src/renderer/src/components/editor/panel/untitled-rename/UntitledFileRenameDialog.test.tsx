// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'

function saveAs(currentName: string, typedName: string): ReturnType<typeof vi.fn> {
  const onConfirm = vi.fn()
  render(
    <UntitledFileRenameDialog
      open
      currentName={currentName}
      worktreePath="/repo"
      onClose={vi.fn()}
      onConfirm={onConfirm}
    />
  )
  fireEvent.change(screen.getByPlaceholderText('file name'), { target: { value: typedName } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  return onConfirm
}

describe('UntitledFileRenameDialog', () => {
  afterEach(cleanup)

  it('keeps a plugin compound extension instead of saving as markdown', () => {
    expect(saveAs('untitled-2.excalidraw.svg', 'architecture')).toHaveBeenCalledWith(
      'architecture.excalidraw.svg'
    )
  })

  it('does not double a suffix the user re-typed', () => {
    expect(saveAs('untitled.excalidraw', 'arch.excalidraw')).toHaveBeenCalledWith('arch.excalidraw')
  })

  it('saves an extensionless recovered file without adding a suffix', () => {
    expect(saveAs('Makefile (recovered)', 'Makefile')).toHaveBeenCalledWith('Makefile')
  })
})
