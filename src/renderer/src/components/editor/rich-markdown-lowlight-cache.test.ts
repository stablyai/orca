import { common, createLowlight } from 'lowlight'
import { describe, expect, it, vi } from 'vitest'
import { createCachedLowlight } from './rich-markdown-lowlight-cache'

const CODE = 'export function handler(input: string): string { return input.trim() }'

describe('createCachedLowlight', () => {
  it('reuses one exact-language result across 533 identical code blocks', () => {
    const lowlight = createLowlight(common)
    const highlight = vi.spyOn(lowlight, 'highlight')
    const cached = createCachedLowlight(lowlight)

    for (let index = 0; index < 533; index += 1) {
      cached.highlight('typescript', CODE)
    }

    expect(highlight).toHaveBeenCalledOnce()
  })

  it('matches lowlight for exact-language and automatic highlighting', () => {
    const stock = createLowlight(common)
    const cached = createCachedLowlight(createLowlight(common))

    expect(cached.highlight('typescript', CODE, { prefix: 'syntax-' })).toEqual(
      stock.highlight('typescript', CODE, { prefix: 'syntax-' })
    )
    expect(
      cached.highlightAuto(CODE, {
        prefix: 'syntax-',
        subset: ['javascript', 'typescript']
      })
    ).toEqual(
      stock.highlightAuto(CODE, {
        prefix: 'syntax-',
        subset: ['javascript', 'typescript']
      })
    )
  })

  it('preserves language registration', () => {
    const cached = createCachedLowlight(createLowlight())

    cached.register('typescript', common.typescript)

    expect(cached.listLanguages()).toEqual(['typescript'])
    expect(cached.registered('typescript')).toBe(true)
    expect(cached.highlight('typescript', CODE).children).not.toHaveLength(0)
  })

  it('keys explicit language, automatic mode, and supported options independently', () => {
    const lowlight = createLowlight(common)
    const highlight = vi.spyOn(lowlight, 'highlight')
    const highlightAuto = vi.spyOn(lowlight, 'highlightAuto')
    const cached = createCachedLowlight(lowlight)

    cached.highlight('typescript', CODE, { prefix: 'first-' })
    cached.highlight('typescript', CODE, { prefix: 'second-' })
    cached.highlight('typescript', CODE, { prefix: 'first-' })
    cached.highlightAuto(CODE, { subset: ['typescript'] })
    cached.highlightAuto(CODE, { subset: ['javascript'] })
    cached.highlightAuto(CODE, { subset: ['typescript'] })

    expect(highlight).toHaveBeenCalledTimes(2)
    expect(highlightAuto).toHaveBeenCalledTimes(2)
  })

  it('preserves registration APIs and invalidates results after registry changes', () => {
    const lowlight = createLowlight(common)
    const reference = createLowlight(common)
    const highlight = vi.spyOn(lowlight, 'highlight')
    const cached = createCachedLowlight(lowlight)

    cached.highlight('javascript', CODE)
    cached.highlight('javascript', CODE)
    cached.registerAlias('javascript', 'cached-js')
    reference.registerAlias('javascript', 'cached-js')

    expect(cached.registered('cached-js')).toBe(true)
    expect(cached.highlight('cached-js', CODE)).toEqual(reference.highlight('cached-js', CODE))
    cached.highlight('javascript', CODE)
    expect(highlight).toHaveBeenCalledTimes(3)
  })

  it('evicts least-recently-used results by entry count', () => {
    const lowlight = createLowlight(common)
    const highlight = vi.spyOn(lowlight, 'highlight')
    const cached = createCachedLowlight(lowlight, {
      maxEntries: 2,
      maxSourceCharacters: 100
    })

    cached.highlight('typescript', 'first')
    cached.highlight('typescript', 'second')
    cached.highlight('typescript', 'first')
    cached.highlight('typescript', 'third')
    cached.highlight('typescript', 'second')

    expect(highlight).toHaveBeenCalledTimes(4)
  })

  it('bounds retained source text and does not retain oversized blocks', () => {
    const lowlight = createLowlight(common)
    const highlight = vi.spyOn(lowlight, 'highlight')
    const cached = createCachedLowlight(lowlight, {
      maxEntries: 10,
      maxSourceCharacters: 5
    })

    cached.highlight('typescript', '123')
    cached.highlight('typescript', '456')
    cached.highlight('typescript', '123')
    cached.highlight('typescript', '123456')
    cached.highlight('typescript', '123456')

    expect(highlight).toHaveBeenCalledTimes(5)
  })
})
