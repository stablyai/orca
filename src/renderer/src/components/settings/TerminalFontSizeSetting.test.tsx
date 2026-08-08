// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { TerminalFontSizeSetting } from './TerminalFontSizeSetting'

const MAIN_CSS = resolve(__dirname, '../../assets/main.css')

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

  // Why: happy-dom cannot render the webkit spin button, so the class plus the rule
  // it resolves to are the only assertable proxy for "the value is not overlapped".
  it('suppresses the native spin buttons that clip the value', () => {
    renderSetting(15)

    expect(getInput().classList.contains('number-input-clean')).toBe(true)
    // Why: comments are stripped so a commented-out rule cannot pass, and only the
    // matched rule is asserted so a failure prints it instead of the whole stylesheet.
    const css = readFileSync(MAIN_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const spinButtonRule = css.match(
      /\.number-input-clean::-webkit-inner-spin-button[^{]*\{[^}]*\}/
    )
    expect(spinButtonRule?.[0] ?? 'no .number-input-clean spin-button rule in main.css').toMatch(
      /(?:^|[\s;{])(?:-webkit-)?appearance:\s*none/
    )
  })

  it('uses the same width as the shared numeric settings inputs', () => {
    renderSetting(15)

    expect(getInput().classList.contains('w-24')).toBe(true)
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
