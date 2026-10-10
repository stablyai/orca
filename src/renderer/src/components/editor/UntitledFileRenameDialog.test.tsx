// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'

afterEach(cleanup)

function saveInto(folder: string, worktreePath = '/repo', disableBrowse = false) {
  const onConfirm = vi.fn()
  render(
    <UntitledFileRenameDialog
      open
      currentName="untitled.md"
      worktreePath={worktreePath}
      disableBrowse={disableBrowse}
      onClose={vi.fn()}
      onConfirm={onConfirm}
    />
  )
  const inputs = screen.getAllByRole('textbox')
  fireEvent.change(inputs[0]!, { target: { value: 'scratch.md' } })
  fireEvent.change(inputs[1]!, { target: { value: folder } })
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
  return onConfirm
}

describe('untitled Save As destination', () => {
  it.each([
    ['/Users/me/Desktop', '/repo', '/Users/me/Desktop/scratch.md'],
    ['/repo/notes/', '/repo', '/repo/notes/scratch.md'],
    ['/', '/repo', '/scratch.md'],
    ['D:\\Notes\\', 'C:\\Repo', 'D:\\Notes\\scratch.md'],
    ['C:\\', 'C:\\Repo', 'C:\\scratch.md'],
    ['\\\\server\\share\\Notes', 'C:\\Repo', '\\\\server\\share\\Notes\\scratch.md'],
    [
      '\\\\wsl.localhost\\Ubuntu\\home\\me',
      'C:\\Repo',
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\scratch.md'
    ],
    ['/home/me/a\\b', '/repo', '/home/me/a\\b/scratch.md']
  ])('passes the absolute local destination in %s', (folder, root, expected) => {
    expect(saveInto(folder, root)).toHaveBeenCalledWith(expected)
  })

  it('rejects a relative directory before any save', () => {
    expect(saveInto('notes')).not.toHaveBeenCalled()
    expect(screen.getByText('Folder path must be absolute')).toBeTruthy()
  })

  it('keeps remote destinations inside the owning workspace', () => {
    expect(saveInto('/home/me/notes', '/remote/repo', true)).not.toHaveBeenCalled()
    expect(screen.getByText('Folder must be inside the current workspace')).toBeTruthy()
  })

  it('passes an absolute path for a remote destination inside the workspace', () => {
    expect(saveInto('/remote/repo/docs', '/remote/repo', true)).toHaveBeenCalledWith(
      '/remote/repo/docs/scratch.md'
    )
  })
})
