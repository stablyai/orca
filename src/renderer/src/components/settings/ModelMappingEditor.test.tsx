import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeModelMapping } from '../../../../shared/types'
import {
  ModelMappingEditor,
  formatRelativeAge,
  setMappingTier
} from './ModelMappingEditor'

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
    defaultsFetchedAt: number | null
    onRefreshDefaults: () => void
    refreshing: boolean
    nowMs: number
  }> = {}
): React.ReactElement {
  return ModelMappingEditor({
    mapping: overrides.mapping ?? {},
    defaults: overrides.defaults ?? DEFAULTS,
    onChange: overrides.onChange ?? (() => {}),
    open: overrides.open,
    onToggleOpen: overrides.onToggleOpen,
    defaultsFetchedAt: overrides.defaultsFetchedAt,
    onRefreshDefaults: overrides.onRefreshDefaults,
    refreshing: overrides.refreshing,
    nowMs: overrides.nowMs
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

describe('formatRelativeAge (pure helper)', () => {
  it('returns "just now" for <1m old', () => {
    expect(formatRelativeAge(0)).toMatch(/just now/i)
    expect(formatRelativeAge(45_000)).toMatch(/just now/i)
  })

  it('returns "Nm ago" for minutes', () => {
    expect(formatRelativeAge(2 * 60_000)).toBe('2m ago')
    expect(formatRelativeAge(59 * 60_000)).toBe('59m ago')
  })

  it('returns "Nh ago" for hours', () => {
    expect(formatRelativeAge(60 * 60_000)).toBe('1h ago')
    expect(formatRelativeAge(23 * 60 * 60_000)).toBe('23h ago')
  })

  it('returns "Nd ago" for days', () => {
    expect(formatRelativeAge(24 * 60 * 60_000)).toBe('1d ago')
    expect(formatRelativeAge(2 * 24 * 60 * 60_000)).toBe('2d ago')
    expect(formatRelativeAge(45 * 24 * 60 * 60_000)).toBe('45d ago')
  })

  it('clamps negative deltas to "just now" (clock skew)', () => {
    expect(formatRelativeAge(-1000)).toMatch(/just now/i)
  })
})

describe('ModelMappingEditor — refresh defaults (P3 T19)', () => {
  it('shows "Defaults updated 2d ago" when fetchedAt is 2 days old', () => {
    const now = Date.now()
    const twoDaysAgo = now - 2 * 86400 * 1000
    const tree = renderEditor({
      defaultsFetchedAt: twoDaysAgo,
      onRefreshDefaults: vi.fn(),
      nowMs: now
    })
    const markup = renderToStaticMarkup(tree)
    expect(markup).toMatch(/defaults updated 2d ago/i)
  })

  it('shows "Defaults: built-in" when fetchedAt is null', () => {
    const tree = renderEditor({
      defaultsFetchedAt: null,
      onRefreshDefaults: vi.fn()
    })
    const markup = renderToStaticMarkup(tree)
    expect(markup).toMatch(/built-in/i)
  })

  it('does not render the refresh row when onRefreshDefaults is omitted', () => {
    // Backwards compat: existing consumers that don't pass the new props
    // should see the original editor unchanged.
    const tree = renderEditor()
    const refreshBtn = findByAriaLabel(tree, /refresh defaults/i)
    expect(refreshBtn).toBeNull()
  })

  it('renders a "Refresh defaults" button when onRefreshDefaults is provided', () => {
    const tree = renderEditor({ onRefreshDefaults: vi.fn() })
    const btn = findByAriaLabel(tree, /refresh defaults/i)
    expect(btn).not.toBeNull()
  })

  it('Refresh defaults button click calls onRefreshDefaults', () => {
    const onRefresh = vi.fn()
    const tree = renderEditor({
      defaultsFetchedAt: Date.now(),
      onRefreshDefaults: onRefresh
    })
    const btn = findByAriaLabel(tree, /refresh defaults/i)
    expect(btn).not.toBeNull()
    ;(btn?.props.onClick as () => void)()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('Refresh defaults button is disabled while refreshing is true', () => {
    const tree = renderEditor({
      defaultsFetchedAt: Date.now(),
      onRefreshDefaults: vi.fn(),
      refreshing: true
    })
    const btn = findByAriaLabel(tree, /refresh defaults/i)
    expect(btn?.props.disabled).toBe(true)
  })
})
