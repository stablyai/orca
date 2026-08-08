// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'

function renderDialog(onSubmit: (name: string) => void): HTMLInputElement {
  render(
    <ProjectGroupNameDialog
      open
      title="New Project Group"
      description="Create a group."
      initialName="한국 그룹"
      confirmLabel="Create"
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />
  )
  return screen.getByLabelText('Group Name') as HTMLInputElement
}

afterEach(cleanup)

describe('ProjectGroupNameDialog IME implicit submit', () => {
  it('does not persist a project group on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn()
    const input = renderDialog(onSubmit)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('persists a project group exactly once on an ordinary Enter', () => {
    const onSubmit = vi.fn()
    const input = renderDialog(onSubmit)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('한국 그룹')
  })
})
