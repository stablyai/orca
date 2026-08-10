// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { WorktreeCreateTimeouts } from '../../../../shared/worktree-create-timeouts'
import { WorktreeCreateTimeoutSettings } from './WorktreeCreateTimeoutSettings'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, defaultValue: string) => defaultValue
}))

const INITIAL_TIMEOUTS: WorktreeCreateTimeouts = {
  refreshBaseRefMs: 30_000,
  addCheckoutMs: 120_000,
  registrationMs: 45_000,
  materializationMs: 90_000
}

describe('WorktreeCreateTimeoutSettings', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  function renderSettings(
    updateSettings = vi.fn<(updates: Partial<GlobalSettings>) => void>(),
    searchQuery = '',
    worktreeCreateTimeouts = INITIAL_TIMEOUTS
  ): typeof updateSettings {
    act(() => {
      root.render(
        <WorktreeCreateTimeoutSettings
          settings={{ worktreeCreateTimeouts } as GlobalSettings}
          updateSettings={updateSettings}
          searchQuery={searchQuery}
        />
      )
    })
    return updateSettings
  }

  function getDisclosure(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('button')
    if (!button) {
      throw new Error('worktree timeout disclosure was not rendered')
    }
    return button
  }

  function getInputs(): HTMLInputElement[] {
    return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="number"]'))
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function pressEnter(input: HTMLInputElement): void {
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }

  function blurInput(input: HTMLInputElement): void {
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
  }

  it('keeps the advanced timeout fields collapsed until opened', () => {
    renderSettings()

    expect(getDisclosure().getAttribute('aria-expanded')).toBe('false')
    expect(getInputs()).toHaveLength(0)

    act(() => getDisclosure().click())

    expect(getDisclosure().getAttribute('aria-expanded')).toBe('true')
    expect(getInputs().map((input) => input.value)).toEqual(['30', '120', '45', '90'])
  })

  it('forces the disclosure open when timeout search matches', () => {
    renderSettings(vi.fn(), 'materialization')

    expect(getDisclosure().getAttribute('aria-expanded')).toBe('true')
    expect(getDisclosure().disabled).toBe(true)
    expect(getInputs()).toHaveLength(4)
  })

  it('converts seconds to milliseconds and preserves the full nested object', () => {
    const updateSettings = renderSettings()
    act(() => getDisclosure().click())
    const inputs = getInputs()

    setInputValue(inputs[0], '12')
    pressEnter(inputs[0])
    setInputValue(inputs[1], '34')
    blurInput(inputs[1])

    expect(updateSettings).toHaveBeenNthCalledWith(1, {
      worktreeCreateTimeouts: {
        ...INITIAL_TIMEOUTS,
        refreshBaseRefMs: 12_000
      }
    })
    expect(updateSettings).toHaveBeenNthCalledWith(2, {
      worktreeCreateTimeouts: {
        ...INITIAL_TIMEOUTS,
        refreshBaseRefMs: 12_000,
        addCheckoutMs: 34_000
      }
    })
  })

  it('clamps timeout drafts to 1 through 7200 seconds', () => {
    const updateSettings = renderSettings()
    act(() => getDisclosure().click())
    const inputs = getInputs()

    setInputValue(inputs[2], '0')
    blurInput(inputs[2])
    setInputValue(inputs[3], '9000')
    pressEnter(inputs[3])

    expect(inputs[2].value).toBe('1')
    expect(inputs[3].value).toBe('7200')
    expect(updateSettings).toHaveBeenNthCalledWith(1, {
      worktreeCreateTimeouts: {
        ...INITIAL_TIMEOUTS,
        registrationMs: 1_000
      }
    })
    expect(updateSettings).toHaveBeenNthCalledWith(2, {
      worktreeCreateTimeouts: {
        ...INITIAL_TIMEOUTS,
        registrationMs: 1_000,
        materializationMs: 7_200_000
      }
    })
  })

  it('keeps newer nested edits when an older persistence echo arrives', () => {
    const updateSettings = renderSettings()
    act(() => getDisclosure().click())
    let inputs = getInputs()

    setInputValue(inputs[0], '12')
    pressEnter(inputs[0])
    setInputValue(inputs[1], '34')
    pressEnter(inputs[1])

    renderSettings(updateSettings, '', {
      ...INITIAL_TIMEOUTS,
      refreshBaseRefMs: 12_000
    })
    inputs = getInputs()
    setInputValue(inputs[2], '56')
    pressEnter(inputs[2])

    expect(updateSettings).toHaveBeenLastCalledWith({
      worktreeCreateTimeouts: {
        ...INITIAL_TIMEOUTS,
        refreshBaseRefMs: 12_000,
        addCheckoutMs: 34_000,
        registrationMs: 56_000
      }
    })
  })
})
