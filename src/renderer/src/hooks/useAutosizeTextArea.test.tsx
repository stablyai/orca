// @vitest-environment happy-dom

import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  autosizeTextAreaMaxHeightPx,
  clampAutosizeTextAreaHeight,
  useAutosizeTextArea
} from './useAutosizeTextArea'

describe('autosizeTextAreaMaxHeightPx', () => {
  it('computes maxLines * line-height plus vertical padding', () => {
    // text-sm (20px line-height) with py-1 (4px each side), 8-line cap → 168px.
    const style = { lineHeight: '20px', paddingTop: '4px', paddingBottom: '4px' }
    expect(autosizeTextAreaMaxHeightPx(style, 8)).toBe(168)
  })

  it('rounds fractional line-heights up so the last line is not clipped', () => {
    const style = { lineHeight: '19.5px', paddingTop: '0px', paddingBottom: '0px' }
    expect(autosizeTextAreaMaxHeightPx(style, 2)).toBe(39)
  })

  it('treats unresolved padding as zero', () => {
    const style = { lineHeight: '20px', paddingTop: '', paddingBottom: '' }
    expect(autosizeTextAreaMaxHeightPx(style, 3)).toBe(60)
  })

  it('returns null (no clamp) when line-height does not resolve to pixels', () => {
    const style = { lineHeight: 'normal', paddingTop: '4px', paddingBottom: '4px' }
    expect(autosizeTextAreaMaxHeightPx(style, 8)).toBeNull()
  })
})

describe('clampAutosizeTextAreaHeight', () => {
  it('clamps content height to the cap', () => {
    expect(clampAutosizeTextAreaHeight(300, 168)).toBe(168)
  })

  it('keeps content height below the cap', () => {
    expect(clampAutosizeTextAreaHeight(48, 168)).toBe(48)
  })

  it('grows freely with a null cap', () => {
    expect(clampAutosizeTextAreaHeight(999, null)).toBe(999)
  })
})

describe('useAutosizeTextArea', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function Harness({
    textareaRef,
    value
  }: {
    textareaRef: React.RefObject<HTMLTextAreaElement | null>
    value: string
  }): React.JSX.Element {
    useAutosizeTextArea(textareaRef, value, { maxLines: 8 })
    return <textarea ref={textareaRef} value={value} readOnly />
  }

  function mockLayout(textarea: HTMLTextAreaElement, scrollHeight: { value: number }): void {
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight.value
    })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      lineHeight: '20px',
      paddingTop: '4px',
      paddingBottom: '4px'
    } as CSSStyleDeclaration)
  }

  it('grows to fit the draft and clamps at the 8-line cap', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const scrollHeight = { value: 48 }
    const view = render(<Harness textareaRef={textareaRef} value="hi" />)
    mockLayout(textareaRef.current!, scrollHeight)

    scrollHeight.value = 88
    view.rerender(<Harness textareaRef={textareaRef} value={'a\n'.repeat(4)} />)
    expect(textareaRef.current!.style.height).toBe('88px')

    scrollHeight.value = 400
    view.rerender(<Harness textareaRef={textareaRef} value={'a\n'.repeat(30)} />)
    expect(textareaRef.current!.style.height).toBe('168px')
  })

  it('shrinks back when the draft is cleared (e.g. after send)', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const scrollHeight = { value: 48 }
    const view = render(<Harness textareaRef={textareaRef} value="hi" />)
    mockLayout(textareaRef.current!, scrollHeight)

    scrollHeight.value = 128
    view.rerender(<Harness textareaRef={textareaRef} value={'a\n'.repeat(6)} />)
    expect(textareaRef.current!.style.height).toBe('128px')

    scrollHeight.value = 48
    view.rerender(<Harness textareaRef={textareaRef} value="" />)
    expect(textareaRef.current!.style.height).toBe('48px')
  })
})
