// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { SparseCheckoutPresetDraftForm } from './SparseCheckoutPresetDraftForm'

function renderForm(onSave: () => void): HTMLInputElement {
  render(
    <SparseCheckoutPresetDraftForm
      draft={{ mode: 'new', name: '한국 프리셋', directoriesText: 'src/renderer' }}
      parsedDirectories={{ directories: ['src/renderer'], error: null }}
      nameError={null}
      submitting={false}
      canSave
      setNameInputNode={() => {}}
      onDraftChange={() => {}}
      onCancel={() => {}}
      onSave={onSave}
    />
  )
  return screen.getByLabelText('Name') as HTMLInputElement
}

afterEach(cleanup)

describe('SparseCheckoutPresetDraftForm IME implicit submit', () => {
  it('does not save a preset on the recorded Korean Enter redispatch', () => {
    const onSave = vi.fn()
    const input = renderForm(onSave)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves a preset exactly once on an ordinary Enter', () => {
    const onSave = vi.fn()
    const input = renderForm(onSave)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onSave).toHaveBeenCalledOnce()
  })
})
