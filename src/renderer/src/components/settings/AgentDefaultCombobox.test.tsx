// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  AgentDefaultCombobox,
  filterAgentDefaultOptions,
  type AgentDefaultOption
} from './AgentDefaultCombobox'

const OPTIONS: AgentDefaultOption[] = [
  { id: 'codex', label: 'Codex', baseAgent: 'codex', searchSummary: 'codex codex' },
  {
    id: 'custom-agent:codex:abc',
    label: 'Fast Codex',
    baseAgent: 'codex',
    searchSummary: 'fast codex codex --model'
  },
  { id: 'claude', label: 'Claude', baseAgent: 'claude', searchSummary: 'claude claude' }
]

// happy-dom reports zero layout, so @tanstack/react-virtual (which the picker
// listbox uses) would window nothing and later rows would never mount. Feed the
// listbox a real viewport height and each option row its estimate so rows mount
// deterministically and the mounted-DOM bound is genuinely exercised.
function isOptionElement(el: HTMLElement): boolean {
  return typeof el.getAttribute === 'function' && el.getAttribute('role') === 'option'
}

let restore: (() => void) | undefined
beforeEach(() => {
  const rect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const height = isOptionElement(this) ? 34 : 500
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: height,
      width: 400,
      height,
      toJSON() {}
    }
  }
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isOptionElement(this) ? 34 : 500
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 400
  })
  restore = () => {
    HTMLElement.prototype.getBoundingClientRect = rect
    if (offsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
    if (offsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
    }
  }
})

afterEach(() => {
  restore?.()
  cleanup()
})

describe('filterAgentDefaultOptions', () => {
  it('returns every option for an empty query', () => {
    expect(filterAgentDefaultOptions(OPTIONS, '   ')).toHaveLength(3)
  })

  it('matches label, base, and command summary case-insensitively', () => {
    expect(filterAgentDefaultOptions(OPTIONS, 'FAST').map((o) => o.id)).toEqual([
      'custom-agent:codex:abc'
    ])
    expect(filterAgentDefaultOptions(OPTIONS, 'claude').map((o) => o.id)).toEqual(['claude'])
    expect(filterAgentDefaultOptions(OPTIONS, '--model').map((o) => o.id)).toEqual([
      'custom-agent:codex:abc'
    ])
  })

  it('returns nothing when no summary matches', () => {
    expect(filterAgentDefaultOptions(OPTIONS, 'nonesuch')).toHaveLength(0)
  })
})

describe('AgentDefaultCombobox', () => {
  it('shows the current selection in the trigger', () => {
    const { rerender } = render(
      <AgentDefaultCombobox value="auto" options={OPTIONS} onChange={vi.fn()} />
    )
    expect(screen.getByRole('combobox').textContent).toContain('Auto')
    rerender(<AgentDefaultCombobox value="blank" options={OPTIONS} onChange={vi.fn()} />)
    expect(screen.getByRole('combobox').textContent).toContain('Blank Terminal')
    rerender(
      <AgentDefaultCombobox value="custom-agent:codex:abc" options={OPTIONS} onChange={vi.fn()} />
    )
    expect(screen.getByRole('combobox').textContent).toContain('Fast Codex')
  })

  it('renders a repair warning and the stale label when the default is unavailable', () => {
    render(
      <AgentDefaultCombobox
        value="custom-agent:codex:gone"
        options={OPTIONS}
        staleDefault={{ id: 'custom-agent:codex:gone', label: 'Removed Agent', baseAgent: 'codex' }}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByRole('combobox').textContent).toContain('Removed Agent')
    expect(screen.getByText(/attended launches use the stock/i)).toBeTruthy()
  })

  it('renders a placeholder trigger and checks nothing when unset', () => {
    render(<AgentDefaultCombobox value="auto" options={OPTIONS} unset onChange={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('Choose a default agent')
    expect(trigger.textContent).not.toContain('Auto')
    fireEvent.click(trigger)
    // No opacity-100 check anywhere: unset selects nothing, including Auto.
    expect(document.querySelector('.opacity-100')).toBeNull()
  })

  it('selects Auto, Blank, and an identity from the open list', () => {
    const onChange = vi.fn()
    render(<AgentDefaultCombobox value="auto" options={OPTIONS} onChange={onChange} />)

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByText('Fast Codex'))
    expect(onChange).toHaveBeenCalledWith('custom-agent:codex:abc')

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByText('Blank Terminal'))
    expect(onChange).toHaveBeenCalledWith('blank')
  })

  it('filters the list by the typed query', () => {
    render(<AgentDefaultCombobox value="auto" options={OPTIONS} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.change(screen.getByPlaceholderText('Search agents...'), { target: { value: 'fast' } })
    expect(screen.queryByText('Fast Codex')).toBeTruthy()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  it('navigates the open list with the arrow keys and selects with Enter', () => {
    const onChange = vi.fn()
    render(<AgentDefaultCombobox value="auto" options={OPTIONS} onChange={onChange} />)
    fireEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText('Search agents...')
    // Opens with Auto highlighted (the current value); step down to Codex.
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // Blank
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // Codex
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('codex')
  })

  it('wires listbox/option aria and tracks the active row via aria-activedescendant', () => {
    render(<AgentDefaultCombobox value="auto" options={OPTIONS} onChange={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    const listboxId = trigger.getAttribute('aria-controls')
    expect(listboxId).toBeTruthy()

    fireEvent.click(trigger)
    const listbox = document.getElementById(listboxId as string)
    expect(listbox?.getAttribute('role')).toBe('listbox')

    const input = screen.getByPlaceholderText('Search agents...')
    const activeOption = document.querySelector('[role="option"][aria-selected="true"]')
    expect(activeOption).toBeTruthy()
    // Opens on the current value (Auto), and the input points at it.
    expect(input.getAttribute('aria-activedescendant')).toBe(activeOption?.id)
    expect(activeOption?.textContent).toContain('Auto')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const nextActive = document.querySelector('[role="option"][aria-selected="true"]')
    expect(input.getAttribute('aria-activedescendant')).toBe(nextActive?.id)
    expect(nextActive?.textContent).toContain('Blank Terminal')
  })

  it('mounts a bounded row set and still reaches the last row via keyboard at 1,000 options', () => {
    const many: AgentDefaultOption[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `custom-agent:codex:${i}`,
      label: `Agent ${i}`,
      baseAgent: 'codex',
      searchSummary: `agent ${i} codex`
    }))
    const onChange = vi.fn()
    render(<AgentDefaultCombobox value="auto" options={many} onChange={onChange} />)
    fireEvent.click(screen.getByRole('combobox'))

    const mounted = document.querySelectorAll('[role="option"]')
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThanOrEqual(60)

    // End jumps the active row to the last option — unmounted under the window,
    // exactly cmdk's dead end — and Enter selects it deterministically.
    const input = screen.getByPlaceholderText('Search agents...')
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('custom-agent:codex:999')
  })

  it('moves focus to the trigger on mount when autoFocusTrigger is set', () => {
    render(
      <AgentDefaultCombobox
        value="auto"
        options={OPTIONS}
        unset
        autoFocusTrigger
        onChange={vi.fn()}
      />
    )
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('does not grab focus when autoFocusTrigger is not set', () => {
    render(<AgentDefaultCombobox value="auto" options={OPTIONS} onChange={vi.fn()} />)
    expect(document.activeElement).not.toBe(screen.getByRole('combobox'))
  })

  it('always offers the Auto helper copy', () => {
    render(<AgentDefaultCombobox value="auto" options={OPTIONS} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByText('Auto never selects a custom agent.')).toBeTruthy()
  })
})
