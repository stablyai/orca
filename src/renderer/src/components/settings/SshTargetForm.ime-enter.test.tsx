// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { EMPTY_FORM } from './ssh-target-draft'
import { SshTargetForm } from './SshTargetForm'

function renderForm(onSave: () => void): HTMLInputElement {
  render(
    <SshTargetForm
      open
      editingId={null}
      form={{ ...EMPTY_FORM, label: '한국 서버', host: 'server.example.com' }}
      saving={false}
      onFormChange={() => {}}
      onSave={onSave}
      onOpenChange={() => {}}
    />
  )
  return screen.getByLabelText('Label') as HTMLInputElement
}

afterEach(cleanup)

describe('SshTargetForm IME implicit submit', () => {
  it('does not persist an SSH target on the recorded Korean Enter redispatch', () => {
    const onSave = vi.fn()
    const input = renderForm(onSave)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('persists an SSH target exactly once on an ordinary Enter', () => {
    const onSave = vi.fn()
    const input = renderForm(onSave)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onSave).toHaveBeenCalledOnce()
  })
})
