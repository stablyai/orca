// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalHotkeySetting, acceleratorToKeys, eventToAccelerator } from './GlobalHotkeySetting'

function keyEvent(overrides: Partial<Parameters<typeof eventToAccelerator>[0]>) {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: '',
    code: '',
    ...overrides
  }
}

describe('eventToAccelerator', () => {
  it('maps Alt+Space to the Electron accelerator', () => {
    expect(eventToAccelerator(keyEvent({ altKey: true, key: ' ', code: 'Space' }))).toBe(
      'Alt+Space'
    )
  })

  it('keeps Control and Meta distinct instead of collapsing to CommandOrControl', () => {
    expect(eventToAccelerator(keyEvent({ ctrlKey: true, key: 'k', code: 'KeyK' }))).toBe(
      'Control+K'
    )
    expect(eventToAccelerator(keyEvent({ metaKey: true, key: 'k', code: 'KeyK' }))).toBe('Super+K')
  })

  it('combines multiple modifiers', () => {
    expect(
      eventToAccelerator(
        keyEvent({ metaKey: true, ctrlKey: true, shiftKey: true, key: 'p', code: 'KeyP' })
      )
    ).toBe('Super+Control+Shift+P')
  })

  it('rejects chords without a modifier', () => {
    expect(eventToAccelerator(keyEvent({ key: 'a', code: 'KeyA' }))).toBeNull()
    expect(eventToAccelerator(keyEvent({ key: 'F5', code: 'F5' }))).toBeNull()
  })

  it('rejects pure modifier presses', () => {
    expect(eventToAccelerator(keyEvent({ altKey: true, key: 'Alt', code: 'AltLeft' }))).toBeNull()
    expect(
      eventToAccelerator(keyEvent({ metaKey: true, key: 'Meta', code: 'MetaLeft' }))
    ).toBeNull()
  })

  it('maps digits, F-keys, and named keys', () => {
    expect(eventToAccelerator(keyEvent({ altKey: true, key: '1', code: 'Digit1' }))).toBe('Alt+1')
    expect(eventToAccelerator(keyEvent({ altKey: true, key: 'F6', code: 'F6' }))).toBe('Alt+F6')
    expect(eventToAccelerator(keyEvent({ altKey: true, key: 'ArrowUp', code: 'ArrowUp' }))).toBe(
      'Alt+Up'
    )
  })
})

describe('acceleratorToKeys', () => {
  it('returns no keys for an empty accelerator', () => {
    expect(acceleratorToKeys('')).toEqual([])
    expect(acceleratorToKeys('  ')).toEqual([])
  })

  it('splits an accelerator into display labels', () => {
    // happy-dom's user agent is not a Mac, so labels use the non-Mac branch.
    expect(acceleratorToKeys('Alt+Space')).toEqual(['Alt', 'Space'])
    expect(acceleratorToKeys('Super+Shift+K')).toEqual(['Win', 'Shift', 'K'])
  })
})

describe('GlobalHotkeySetting', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderSetting(value: string | undefined, onChange = vi.fn()) {
    act(() => {
      root.render(<GlobalHotkeySetting value={value} onChange={onChange} />)
    })
    const recordButton = container.querySelector('button')!
    return { onChange, recordButton }
  }

  function pressKey(
    target: Element,
    init: { key: string; code: string; altKey?: boolean; ctrlKey?: boolean }
  ) {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
    })
  }

  it('shows the record affordance when disabled and the combo when set', () => {
    const disabled = renderSetting('')
    expect(disabled.recordButton.textContent).toContain('Click to record')

    const enabled = renderSetting('Alt+Space')
    expect(enabled.recordButton.textContent).toContain('Alt')
    expect(enabled.recordButton.textContent).toContain('Space')
  })

  it('records a chord and reports it through onChange', () => {
    const { onChange, recordButton } = renderSetting('')
    act(() => {
      recordButton.click()
    })
    expect(recordButton.getAttribute('aria-pressed')).toBe('true')
    pressKey(recordButton, { key: ' ', code: 'Space', altKey: true })
    expect(onChange).toHaveBeenCalledWith('Alt+Space')
    expect(recordButton.getAttribute('aria-pressed')).toBe('false')
  })

  it('cancels recording on Escape without changing the value', () => {
    const { onChange, recordButton } = renderSetting('Alt+Space')
    act(() => {
      recordButton.click()
    })
    pressKey(recordButton, { key: 'Escape', code: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(recordButton.getAttribute('aria-pressed')).toBe('false')
  })

  it('ignores modifier-less presses while recording', () => {
    const { onChange, recordButton } = renderSetting('')
    act(() => {
      recordButton.click()
    })
    pressKey(recordButton, { key: 'a', code: 'KeyA' })
    expect(onChange).not.toHaveBeenCalled()
    expect(recordButton.getAttribute('aria-pressed')).toBe('true')
  })

  it('clears the hotkey via the disable button', () => {
    const { onChange } = renderSetting('Alt+Space')
    const clearButton = container.querySelectorAll('button')[1]!
    act(() => {
      clearButton.click()
    })
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('offers no disable button when already disabled', () => {
    renderSetting('')
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })
})
