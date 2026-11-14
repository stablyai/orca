// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddRepoDialogChrome } from './AddRepoDialogChrome'
import { AddRepoLocalStartStep } from './AddRepoStartSteps'

afterEach(cleanup)

function CloneDialog({
  isCloning,
  onOpenChange
}: {
  isCloning: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [isOpen, setIsOpen] = useState(true)
  return (
    <AddRepoDialogChrome
      isCloning={isCloning}
      isAdding={false}
      isOpen={isOpen}
      step="clone"
      onBack={() => {}}
      onOpenChange={(open) => {
        onOpenChange(open)
        setIsOpen(open)
      }}
    >
      <DialogTitle>Clone from URL</DialogTitle>
      <DialogDescription>Clone progress</DialogDescription>
    </AddRepoDialogChrome>
  )
}

function backdrop(): Element {
  const overlay = document.querySelector('[data-slot="dialog-overlay"]')
  if (!overlay) {
    throw new Error('Missing dialog backdrop')
  }
  return overlay
}

describe('AddRepoDialogChrome dismissal', () => {
  it('allows backdrop dismissal after the clone settles', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const view = render(<CloneDialog isCloning onOpenChange={onOpenChange} />)
    await user.click(backdrop())
    expect(onOpenChange).not.toHaveBeenCalled()

    view.rerender(<CloneDialog isCloning={false} onOpenChange={onOpenChange} />)
    await user.click(backdrop())

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog', { name: 'Clone from URL' })).toBeNull()
  })
})

function AddOverComposer() {
  const [adding, setAdding] = useState(false)
  return (
    <TooltipProvider>
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>New workspace</DialogTitle>
          <button onClick={() => setAdding(true)}>Open add project</button>
          <AddRepoDialogChrome
            isCloning={false}
            isAdding={false}
            isOpen={adding}
            step="add"
            onBack={() => {}}
            onOpenChange={setAdding}
          >
            <AddRepoLocalStartStep
              repoCount={1}
              isAdding={false}
              addProjectBusyLabel={null}
              nestedScanInProgress={false}
              nestedScanId={null}
              hostSelector={<button type="button">Local Mac</button>}
              onBrowse={vi.fn()}
              onOpenCloneStep={vi.fn()}
              onOpenRemoteStep={vi.fn()}
              onOpenCreateStep={vi.fn()}
              onStopNestedScan={vi.fn()}
            />
          </AddRepoDialogChrome>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

describe('AddRepoDialogChrome initial focus', () => {
  it('starts on Browse when opened over another dialog', async () => {
    const user = userEvent.setup()
    render(<AddOverComposer />)
    await user.click(screen.getByRole('button', { name: 'Open add project' }))

    expect(document.activeElement?.textContent).toContain('Browse folder')
  })
})
