// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '../../ui/tooltip'
import { CloudSecretHint, cloudSecretHintGap, maskedHint } from './CloudSecretHint'

function renderHint(hint: string | null, canSeeHints: boolean | null) {
  return render(
    <TooltipProvider>
      <CloudSecretHint hint={hint} canSeeHints={canSeeHints} />
    </TooltipProvider>
  )
}

describe('cloudSecretHintGap', () => {
  it('names no gap when there is an ending to show', () => {
    expect(cloudSecretHintGap('x7Qa', true)).toBeNull()
    expect(cloudSecretHintGap('x7Qa', false)).toBeNull()
  })

  it('a caller who may see hints and got none has a short value', () => {
    expect(cloudSecretHintGap(null, true)).toBe('too_short')
  })

  it('a caller the server withholds hints from is told only owners and admins see them', () => {
    expect(cloudSecretHintGap(null, false)).toBe('admins_only')
  })

  it('makes no claim before the caller is known', () => {
    expect(cloudSecretHintGap(null, null)).toBeNull()
  })
})

describe('CloudSecretHint', () => {
  afterEach(() => cleanup())

  it('shows the ending and announces it', () => {
    const { container } = renderHint('x7Qa', true)
    expect(container.querySelector('[aria-hidden]')?.textContent).toBe(maskedHint('x7Qa'))
    expect(container.querySelector('.sr-only')?.textContent).toBe('Value hidden, ends in x7Qa')
    expect(container.querySelector('[data-hint-gap]')).toBeNull()
  })

  it('a short value says why it has no ending, to screen readers too', () => {
    const { container } = renderHint(null, true)
    expect(container.querySelector('[data-hint-gap]')?.getAttribute('data-hint-gap')).toBe(
      'too_short'
    )
    expect(container.querySelector('.sr-only')?.textContent).toBe('Short values are fully hidden')
  })

  it('a member viewing a team scope is told only owners and admins see the ending', () => {
    const { container } = renderHint(null, false)
    expect(container.querySelector('[data-hint-gap]')?.textContent).toBe('••••')
    expect(container.querySelector('.sr-only')?.textContent).toBe(
      'Only owners and admins see the last characters'
    )
  })

  it('falls back to the plain label while the caller is unknown', () => {
    const { container } = renderHint(null, null)
    expect(container.querySelector('[data-hint-gap]')).toBeNull()
    expect(container.querySelector('.sr-only')?.textContent).toBe('Value hidden')
  })
})
