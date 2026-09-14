// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TerminalFontSizeSetting } from './TerminalFontSizeSetting'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, defaultValue: string) => defaultValue
}))

describe('TerminalFontSizeSetting', () => {
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

  function renderSetting(terminalFontSize: number, updateSettings = vi.fn()): void {
    act(() => {
      root.render(
        <TerminalFontSizeSetting
          settings={{ terminalFontSize } as GlobalSettings}
          updateSettings={updateSettings}
          forceVisible
        />
      )
    })
  }

  function getInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')
    if (!input) {
      throw new Error('font size input not found')
    }
    return input
  }

  function getStepperButtons(): { decrement: HTMLButtonElement; increment: HTMLButtonElement } {
    const [decrement, increment] = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    )
    if (!decrement || !increment) {
      throw new Error('stepper buttons not found')
    }
    return { decrement, increment }
  }

  it('keeps the two-digit input compact without native spin buttons', () => {
    renderSetting(15)

    expect(Array.from(getInput().classList)).toEqual(
      expect.arrayContaining(['number-input-clean', 'w-14'])
    )
  })

  it('steps the font size within the supported range', () => {
    const updateSettings = vi.fn()
    renderSetting(15, updateSettings)

    const { decrement, increment } = getStepperButtons()

    act(() => increment.click())
    expect(updateSettings).toHaveBeenCalledWith({ terminalFontSize: 16 })

    act(() => decrement.click())
    expect(updateSettings).toHaveBeenCalledWith({ terminalFontSize: 14 })
  })

  it('disables the steppers at the range bounds', () => {
    renderSetting(10)
    expect(getStepperButtons().decrement.disabled).toBe(true)
    expect(getStepperButtons().increment.disabled).toBe(false)

    renderSetting(24)
    expect(getStepperButtons().decrement.disabled).toBe(false)
    expect(getStepperButtons().increment.disabled).toBe(true)
  })
})
