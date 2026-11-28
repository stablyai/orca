// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useBrowserAnnotationDrafts } from './use-browser-annotation-drafts'

describe('useBrowserAnnotationDrafts', () => {
  it('keeps an unsent comment for its element while the mode is on, and lets it go when the mode ends', () => {
    const { result, rerender } = renderHook(({ on }) => useBrowserAnnotationDrafts(on), {
      initialProps: { on: true }
    })
    result.current.set('https://acme.test\nbutton#buy', {
      comment: 'Make this green',
      intent: 'change'
    })

    expect(result.current.get('https://acme.test\nbutton#buy')).toEqual({
      comment: 'Make this green',
      intent: 'change'
    })
    expect(result.current.get('https://acme.test\nh1')).toBeUndefined()

    rerender({ on: false })
    expect(result.current.get('https://acme.test\nbutton#buy')).toBeUndefined()
  })
})
