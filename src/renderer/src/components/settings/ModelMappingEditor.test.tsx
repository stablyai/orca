import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeModelMapping } from '../../../../shared/types'
import { ModelMappingEditor, setMappingTier } from './ModelMappingEditor'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function collectText(node: unknown): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const element = node as ReactElementLike
  return collectText(element.props?.children)
}

function findById(node: unknown, id: string): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (found) return
    if (entry.props.id === id) {
      found = entry
    }
  })
  return found
}

function findByAriaLabel(node: unknown, ariaLabel: RegExp | string): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (found) return
    const label = entry.props['aria-label']
    if (typeof label !== 'string') return
    if (typeof ariaLabel === 'string') {
      if (label === ariaLabel) found = entry
    } else if (ariaLabel.test(label)) {
      found = entry
    }
  })
  return found
}

function findByType(node: unknown, type: string): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (found) return
    if (entry.type === type) found = entry
  })
  return found
}

function findAllByType(node: unknown, type: string): ReactElementLike[] {
  const results: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.type === type) results.push(entry)
  })
  return results
}

const DEFAULTS: ClaudeModelMapping = {
  opus: 'claude-opus-default',
  sonnet: 'claude-sonnet-default',
  haiku: 'claude-haiku-default'
}

function renderEditor(
  overrides: Partial<{
    mapping: ClaudeModelMapping
    defaults: ClaudeModelMapping
    onChange: (next: ClaudeModelMapping) => void
    open: boolean
    onToggleOpen: (open: boolean) => void
  }> = {}
): React.ReactElement {
  return ModelMappingEditor({
    mapping: overrides.mapping ?? {},
    defaults: overrides.defaults ?? DEFAULTS,
    onChange: overrides.onChange ?? (() => {}),
    open: overrides.open,
    onToggleOpen: overrides.onToggleOpen
  })
}

describe('setMappingTier (pure helper)', () => {
  it('sets a tier value', () => {
    const next = setMappingTier({}, 'opus', 'my-opus')
    expect(next).toEqual({ opus: 'my-opus' })
  })

  it('overwrites existing tier value', () => {
    const next = setMappingTier({ opus: 'old' }, 'opus', 'new')
    expect(next).toEqual({ opus: 'new' })
  })

  it('does not mutate the input mapping', () => {
    const input: ClaudeModelMapping = { opus: 'orig' }
    setMappingTier(input, 'sonnet', 'added')
    expect(input).toEqual({ opus: 'orig' })
  })

  it('clears a tier when value is undefined', () => {
    const next = setMappingTier({ opus: 'x', sonnet: 'y' }, 'opus', undefined)
    expect(next).toEqual({ sonnet: 'y' })
    expect('opus' in next).toBe(false)
  })

  it('clears a tier when value is empty string', () => {
    const next = setMappingTier({ opus: 'x' }, 'opus', '')
    expect('opus' in next).toBe(false)
  })

  it('clears a tier when value is whitespace only', () => {
    const next = setMappingTier({ opus: 'x' }, 'opus', '   ')
    expect('opus' in next).toBe(false)
  })

  it('preserves untouched tiers when clearing', () => {
    const next = setMappingTier({ opus: 'a', sonnet: 'b', haiku: 'c' }, 'sonnet', undefined)
    expect(next).toEqual({ opus: 'a', haiku: 'c' })
  })
})

describe('ModelMappingEditor — rendering', () => {
  it('renders three labeled inputs for Opus / Sonnet / Haiku', () => {
    const tree = renderEditor()

    expect(findById(tree, 'mm-opus')).not.toBeNull()
    expect(findById(tree, 'mm-sonnet')).not.toBeNull()
    expect(findById(tree, 'mm-haiku')).not.toBeNull()

    const markup = renderToStaticMarkup(tree)
    expect(markup).toMatch(/opus/i)
    expect(markup).toMatch(/sonnet/i)
    expect(markup).toMatch(/haiku/i)
  })

  it('uses provider defaults as input placeholders', () => {
    const tree = renderEditor()
    expect(findById(tree, 'mm-opus')?.props.placeholder).toBe('claude-opus-default')
    expect(findById(tree, 'mm-sonnet')?.props.placeholder).toBe('claude-sonnet-default')
    expect(findById(tree, 'mm-haiku')?.props.placeholder).toBe('claude-haiku-default')
  })

  it('a customized tier (mapping.opus set) shows a Reset button', () => {
    const tree = renderEditor({ mapping: { opus: 'custom-opus' } })
    const reset = findByAriaLabel(tree, /reset opus/i)
    expect(reset).not.toBeNull()
  })

  it('default tiers (mapping value undefined) do NOT show a Reset button', () => {
    const tree = renderEditor({ mapping: { opus: 'custom-opus' } })
    // Only the opus tier is customized — sonnet and haiku should NOT have reset buttons.
    expect(findByAriaLabel(tree, /reset sonnet/i)).toBeNull()
    expect(findByAriaLabel(tree, /reset haiku/i)).toBeNull()
  })

  it('customized tier has a visual marker (bold label + dot indicator)', () => {
    const tree = renderEditor({ mapping: { sonnet: 'custom-sonnet' } })
    const markup = renderToStaticMarkup(tree)

    // Find the sonnet label. Bold via class containing "bold".
    let sonnetLabel: ReactElementLike | null = null
    visit(tree, (entry) => {
      if (sonnetLabel) return
      if (entry.props.htmlFor === 'mm-sonnet') {
        sonnetLabel = entry
      }
    })
    expect(sonnetLabel).not.toBeNull()
    const className = (sonnetLabel as unknown as ReactElementLike).props.className
    expect(typeof className === 'string' && /bold/.test(className)).toBe(true)

    // Dot indicator appears in the rendered markup for the customized tier.
    expect(markup).toMatch(/•/)
  })

  it('non-customized labels are NOT bold', () => {
    const tree = renderEditor({ mapping: {} })
    visit(tree, (entry) => {
      if (entry.props.htmlFor === 'mm-opus' || entry.props.htmlFor === 'mm-sonnet' || entry.props.htmlFor === 'mm-haiku') {
        const className = entry.props.className
        if (typeof className === 'string') {
          expect(/bold/.test(className)).toBe(false)
        }
      }
    })
  })
})

describe('ModelMappingEditor — interactions', () => {
  it('clicking Reset Opus calls onChange with opus stripped', () => {
    const onChange = vi.fn()
    const tree = renderEditor({
      mapping: { opus: 'custom-opus', sonnet: 'keep-sonnet' },
      onChange
    })
    const reset = findByAriaLabel(tree, /reset opus/i)
    expect(reset).not.toBeNull()
    const onClick = reset?.props.onClick as () => void
    onClick()
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as ClaudeModelMapping
    expect('opus' in next).toBe(false)
    expect(next.sonnet).toBe('keep-sonnet')
  })

  it('typing in the Sonnet input fires onChange with the new value', () => {
    const onChange = vi.fn()
    const tree = renderEditor({ mapping: {}, onChange })
    const sonnetInput = findById(tree, 'mm-sonnet')
    expect(sonnetInput).not.toBeNull()
    const handler = sonnetInput?.props.onChange as (
      e: { target: { value: string } }
    ) => void
    handler({ target: { value: 'custom-sonnet' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ sonnet: 'custom-sonnet' })
  })

  it('typing an empty value strips the tier (clearing via input)', () => {
    const onChange = vi.fn()
    const tree = renderEditor({ mapping: { haiku: 'previous' }, onChange })
    const haikuInput = findById(tree, 'mm-haiku')
    const handler = haikuInput?.props.onChange as (
      e: { target: { value: string } }
    ) => void
    handler({ target: { value: '' } })
    const next = onChange.mock.calls[0][0] as ClaudeModelMapping
    expect('haiku' in next).toBe(false)
  })

  it('the input value reflects the controlled mapping value', () => {
    const tree = renderEditor({ mapping: { opus: 'my-opus' } })
    const opusInput = findById(tree, 'mm-opus')
    expect(opusInput?.props.value).toBe('my-opus')
  })

  it('the input value is empty string for default tiers (so placeholder shows)', () => {
    const tree = renderEditor({ mapping: {} })
    const opusInput = findById(tree, 'mm-opus')
    expect(opusInput?.props.value).toBe('')
  })
})

describe('ModelMappingEditor — collapsible <details>', () => {
  it('uses a <details> element with a <summary>', () => {
    const tree = renderEditor()
    const details = findByType(tree, 'details')
    expect(details).not.toBeNull()
    const summaries = findAllByType(tree, 'summary')
    expect(summaries.length).toBeGreaterThan(0)
  })

  it('is closed by default (open prop undefined)', () => {
    const tree = renderEditor()
    const details = findByType(tree, 'details')
    // When `open` prop is undefined, the <details> is closed.
    expect(details?.props.open).toBeFalsy()
  })

  it('respects the open prop when controlled', () => {
    const tree = renderEditor({ open: true })
    const details = findByType(tree, 'details')
    expect(details?.props.open).toBe(true)
  })

  it('fires onToggleOpen when the details toggle event fires', () => {
    const onToggleOpen = vi.fn()
    const tree = renderEditor({ open: false, onToggleOpen })
    const details = findByType(tree, 'details')
    const onToggle = details?.props.onToggle as (e: {
      target: { open: boolean }
    }) => void
    expect(typeof onToggle).toBe('function')
    onToggle({ target: { open: true } })
    expect(onToggleOpen).toHaveBeenCalledWith(true)
  })

  it('summary contains a label like "Model mapping"', () => {
    const tree = renderEditor()
    const summaries = findAllByType(tree, 'summary')
    const text = summaries.map(collectText).join(' ')
    expect(text.toLowerCase()).toMatch(/model mapping/)
  })
})
