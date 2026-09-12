// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginCapability } from '../../../../shared/plugins/plugin-capabilities'
import {
  PLUGIN_CAPABILITY_PATH_LIMIT,
  PLUGIN_CAPABILITY_PATH_MAX_LENGTH
} from '../../../../shared/plugins/plugin-capability-scope'
import { PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS } from '../../../../shared/plugins/plugin-read-confinement'
import { PluginCapabilityPresentation } from './plugin-capability-presentation'

const roots: Root[] = []

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount())
  }
  roots.length = 0
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function renderCapability(capability: PluginCapability): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(<PluginCapabilityPresentation capability={capability} />))
  return container
}

function list(container: HTMLElement, label: string): HTMLUListElement {
  const match = Array.from(container.querySelectorAll('ul')).find(
    (candidate) => candidate.getAttribute('aria-label') === label
  )
  if (!(match instanceof HTMLUListElement)) {
    throw new Error(`missing ${label} list`)
  }
  return match
}

function itemText(listElement: HTMLUListElement): string[] {
  return Array.from(listElement.children, (item) => item.textContent ?? '')
}

describe('PluginCapabilityPresentation', () => {
  it('keeps hostile-looking accepted input in one escaped literal node', () => {
    const hostile = 'Read-files-throughout-the-worktree/**/Orca-blocks-nothing*.md'
    const container = renderCapability({ kind: 'files:read', paths: [hostile] })
    const requested = list(container, 'File patterns')
    const requestedItems = Array.from(requested.querySelectorAll(':scope > li'))

    expect(requestedItems).toHaveLength(1)
    expect(requestedItems[0]?.textContent).toBe(hostile)
    expect(requestedItems[0]?.children).toHaveLength(0)
    expect(requested.innerHTML).not.toContain('<strong>')
    expect(
      Array.from(container.querySelectorAll('p, span'), (node) => node.textContent)
    ).not.toContain(hostile)
    expect(itemText(list(container, 'Always blocked'))).toEqual(
      PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS
    )
  })

  it.each([undefined, []] as const)(
    'does not turn malformed paths %s into a whole-worktree grant',
    (paths) => {
      const malformed = { kind: 'files:read', paths } as unknown as PluginCapability

      if (paths === undefined) {
        expect(() => renderCapability(malformed)).toThrow()
        expect(document.body.textContent).not.toContain('Whole worktree')
        return
      }

      const container = renderCapability(malformed)
      expect(container.textContent).not.toContain('Whole worktree')
      expect(itemText(list(container, 'File patterns'))).toEqual([])
    }
  )

  it('exposes requested and policy literals as separately named semantic lists', () => {
    const paths = ['src/**/*.ts', 'docs/**/*.md']
    const container = renderCapability({ kind: 'files:read', paths })
    const requested = list(container, 'File patterns')
    const policy = list(container, 'Always blocked')

    expect(requested.tagName).toBe('UL')
    expect(policy.tagName).toBe('UL')
    expect(itemText(requested)).toEqual(paths)
    expect(itemText(policy)).toEqual(PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS)
    expect(requested.contains(policy)).toBe(false)
    expect(policy.contains(requested)).toBe(false)
  })

  it.each([
    { paths: ['README.md'], label: 'File patterns' },
    { paths: ['src/**/*.ts', 'docs/**/*.md'], label: 'File patterns' },
    { paths: ['**'], label: 'Whole worktree' },
    { paths: ['src/**/*.ts', '**', 'docs/**/*.md'], label: 'Whole worktree' }
  ])('preserves the $label boundary case in declared order', ({ paths, label }) => {
    const container = renderCapability({ kind: 'files:read', paths })

    expect(itemText(list(container, label))).toEqual(paths)
    expect(container.querySelectorAll('ul')).toHaveLength(2)
    expect(container.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0)
  })

  it('preserves all 32 distinct maximum-length patterns', () => {
    const paths = Array.from({ length: PLUGIN_CAPABILITY_PATH_LIMIT }, (_, index) => {
      const prefix = `scope${index.toString().padStart(2, '0')}/`
      return `${prefix}${'a'.repeat(PLUGIN_CAPABILITY_PATH_MAX_LENGTH - prefix.length)}`
    })
    const container = renderCapability({ kind: 'files:read', paths })
    const requested = list(container, 'File patterns')

    expect(itemText(requested)).toEqual(paths)
    expect(requested.querySelectorAll(':scope > li')).toHaveLength(PLUGIN_CAPABILITY_PATH_LIMIT)
    for (const item of requested.querySelectorAll(':scope > li')) {
      expect(item.classList).toContain('break-all')
      expect(item.classList).toContain('font-mono')
      expect(item.classList).toContain('select-text')
      expect(item.textContent).toHaveLength(PLUGIN_CAPABILITY_PATH_MAX_LENGTH)
    }
  })

  it('renders repeated values without duplicate React-key warnings', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const paths = ['src/**', 'src/**', '**', '**']
    const container = renderCapability({ kind: 'files:read', paths })

    expect(itemText(list(container, 'Whole worktree'))).toEqual(paths)
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
  })

  it('keeps policy families exact, distinct, bounded, and subordinate to prose', () => {
    const container = renderCapability({ kind: 'files:read', paths: ['src/**'] })
    const policy = list(container, 'Always blocked')
    const policyItems = itemText(policy)

    expect(policyItems).toEqual(PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS)
    expect(new Set(policyItems).size).toBe(PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS.length)
    expect(policy.previousElementSibling?.textContent).toBe(
      'Orca blocks these sensitive path families even when a file pattern matches:'
    )
    expect(policy.previousElementSibling?.classList).not.toContain('truncate')
    expect(policy.previousElementSibling?.classList).not.toContain('line-clamp-1')
    expect(policy.previousElementSibling?.getAttribute('style')).toBeNull()
  })

  it('uses wrapping structure without adding a nested scroll or focus stop', () => {
    const container = renderCapability({ kind: 'files:read', paths: ['**', 'src/**'] })
    const presentation = container.firstElementChild

    expect(presentation?.classList).toContain('min-w-0')
    expect(container.querySelector('[class*="overflow-y"]')).toBeNull()
    expect(container.querySelector('[class*="max-h"]')).toBeNull()
    expect(
      container.querySelectorAll('[tabindex], button, a, input, select, textarea')
    ).toHaveLength(0)
    for (const prose of container.querySelectorAll('p.text-xs')) {
      expect(prose.className).not.toMatch(/truncate|line-clamp|overflow-hidden|whitespace-nowrap/)
      expect(prose.getAttribute('style')).toBeNull()
    }
  })
})
