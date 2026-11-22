// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'

// Like a card that draws the title elsewhere while renaming, it unmounts the editor when editing ends.
function Card({ onRename }: { onRename: (name: string) => void }): React.JSX.Element {
  const [shown, setShown] = useState(true)
  return (
    <TooltipProvider>
      <button type="button" onClick={() => setShown(false)}>
        Hide
      </button>
      {shown ? (
        <WorktreeTitleInlineRename
          displayName="Old name"
          onRename={onRename}
          onEditingChange={(editing) => {
            if (!editing) {
              setShown(false)
            }
          }}
        />
      ) : null}
    </TooltipProvider>
  )
}

function startEditing(onRename: (name: string) => void): HTMLInputElement {
  render(<Card onRename={onRename} />)
  fireEvent.doubleClick(screen.getByText('Old name'))
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Rename workspace' })
  fireEvent.change(input, { target: { value: 'New name' } })
  return input
}

describe('WorktreeTitleInlineRename unmount', () => {
  afterEach(cleanup)

  it('saves a rename whose field unmounts mid-edit', async () => {
    const onRename = vi.fn()
    startEditing(onRename)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    })
    expect(onRename).toHaveBeenCalledWith('New name')
  })

  it('does not save a rename that Escape cancelled, even when cancelling unmounts the field', async () => {
    const onRename = vi.fn()
    const input = startEditing(onRename)
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    expect(screen.queryByText('Old name')).toBeNull()
    expect(onRename).not.toHaveBeenCalled()
  })
})
