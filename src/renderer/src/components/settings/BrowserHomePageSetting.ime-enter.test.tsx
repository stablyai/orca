// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { BrowserHomePageSetting } from './BrowserHomePageSetting'

function renderSetting(onSave: (url: string | null) => void): HTMLInputElement {
  render(
    <BrowserHomePageSetting value="https://example.com/한글" onChange={() => {}} onSave={onSave} />
  )
  return screen.getByPlaceholderText('https://google.com') as HTMLInputElement
}

afterEach(cleanup)

describe('BrowserHomePageSetting IME implicit submit', () => {
  it('does not persist a home page on the recorded Korean Enter redispatch', () => {
    const onSave = vi.fn()
    const input = renderSetting(onSave)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('persists a home page exactly once on an ordinary Enter', () => {
    const onSave = vi.fn()
    const input = renderSetting(onSave)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave).toHaveBeenCalledWith('https://example.com/%ED%95%9C%EA%B8%80')
  })
})
