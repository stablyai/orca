// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { EMPTY_FORM } from '../settings/ssh-target-draft'
import { SshHostFields } from './AddRemoteHostFields'

function renderForm(onSubmit: () => void): HTMLInputElement {
  render(
    <SshHostFields
      form={{ ...EMPTY_FORM, label: '한국 서버', host: 'server.example.com' }}
      disabled={false}
      onFormChange={() => {}}
      onSubmit={onSubmit}
    />
  )
  return screen.getByLabelText('Label') as HTMLInputElement
}

afterEach(cleanup)

describe('SshHostFields IME implicit submit', () => {
  it('does not persist an SSH host on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn()
    const input = renderForm(onSubmit)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('persists an SSH host exactly once on an ordinary Enter', () => {
    const onSubmit = vi.fn()
    const input = renderForm(onSubmit)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
