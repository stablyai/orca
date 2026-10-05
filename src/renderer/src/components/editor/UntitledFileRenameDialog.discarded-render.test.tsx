// @vitest-environment happy-dom

import React, { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'

// A Suspense unwind discards the render without replaying it; StrictMode cannot show this.
const settledNames = new Set<string>()
let releasePending: (() => void) | null = null

/** Suspends the first render of each unseen name so the sibling dialog's render is discarded. */
function SuspendOnNewName({ currentName }: { currentName: string }): null {
  if (!settledNames.has(currentName)) {
    throw new Promise<void>((resolve) => {
      releasePending = () => {
        settledNames.add(currentName)
        resolve()
      }
    })
  }
  return null
}

/** Renders the open dialog beside a suspender that discards its render when the name changes. */
function Harness({ currentName }: { currentName: string }): React.JSX.Element {
  return (
    <Suspense fallback={<span data-testid="fallback">loading</span>}>
      <UntitledFileRenameDialog
        open
        currentName={currentName}
        worktreePath="/repo"
        onClose={() => {}}
        onConfirm={() => {}}
      />
      <SuspendOnNewName currentName={currentName} />
    </Suspense>
  )
}

beforeEach(() => {
  settledNames.clear()
  settledNames.add('Untitled-1.md')
  releasePending = null
})

afterEach(cleanup)

describe('UntitledFileRenameDialog seeding', () => {
  it('seeds the new file name even when the seeding render is discarded', async () => {
    const { rerender } = render(<Harness currentName="Untitled-1.md" />)
    expect(screen.getByPlaceholderText('file name')).toHaveProperty('value', 'Untitled-1')

    rerender(<Harness currentName="Untitled-2.md" />)
    expect(screen.getByTestId('fallback')).toBeTruthy()

    await act(async () => {
      releasePending?.()
      await Promise.resolve()
    })

    expect(screen.getByPlaceholderText('file name')).toHaveProperty('value', 'Untitled-2')
  })
})
