// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { PluginDevelopmentSection } from './PluginDevelopmentSection'

function renderSection(onChange: (paths: string[]) => Promise<void>): HTMLInputElement {
  render(<PluginDevelopmentSection paths={[]} busy={false} onChange={onChange} />)
  const input = screen.getByLabelText('Development plugin folder path') as HTMLInputElement
  fireEvent.change(input, { target: { value: '/plugins/한글' } })
  return input
}

afterEach(cleanup)

describe('PluginDevelopmentSection IME implicit submit', () => {
  it('does not persist a development path on the recorded Korean Enter redispatch', () => {
    const onChange = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue()
    const input = renderSection(onChange)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('persists a development path exactly once on an ordinary Enter', () => {
    const onChange = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue()
    const input = renderSection(onChange)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(['/plugins/한글'])
  })
})
