// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { OrcaProfileCreateDialog } from './OrcaProfileCreateDialog'

function renderDialog(
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
): HTMLInputElement {
  render(
    <OrcaProfileCreateDialog
      open
      onOpenChange={() => {}}
      name="한국 프로필"
      onNameChange={() => {}}
      creating={false}
      switching={false}
      onSubmit={onSubmit}
    />
  )
  return screen.getByPlaceholderText('Profile name') as HTMLInputElement
}

afterEach(cleanup)

describe('OrcaProfileCreateDialog IME implicit submit', () => {
  it('does not create a profile on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault())
    const input = renderDialog(onSubmit)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('creates a profile exactly once on an ordinary Enter', () => {
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault())
    const input = renderDialog(onSubmit)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
