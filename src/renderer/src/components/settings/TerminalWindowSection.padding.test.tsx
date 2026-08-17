// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { TerminalWindowSection } from './TerminalWindowSection'

type NumberFieldProps = {
  label: string
  value: number
  onChange: (value: number) => void
}

const numberFields = vi.hoisted(() => new Map<string, NumberFieldProps>())

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, defaultValue: string) => defaultValue
}))

vi.mock('./SettingsFormControls', () => ({
  ColorField: function ColorField() {
    return null
  },
  NumberField: function NumberField(props: NumberFieldProps) {
    numberFields.set(props.label, props)
    return null
  }
}))

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: function SearchableSetting({ children }: { children?: ReactNode }) {
    return children ?? null
  }
}))

vi.mock('../ui/button', () => ({ Button: () => null }))
vi.mock('../ui/label', () => ({ Label: () => null }))
vi.mock('../ui/switch', () => ({ Switch: () => null }))

describe('TerminalWindowSection padding', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    numberFields.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  it('displays and persists the same integer padding used by terminal fitting', () => {
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      terminalPaddingX: 1.5,
      terminalPaddingY: 2.5
    } as GlobalSettings

    act(() =>
      root.render(<TerminalWindowSection settings={settings} updateSettings={updateSettings} />)
    )

    const horizontal = numberFields.get('Horizontal Padding')
    const vertical = numberFields.get('Vertical Padding')
    expect(horizontal?.value).toBe(2)
    expect(vertical?.value).toBe(3)

    act(() => horizontal?.onChange(3.5))
    act(() => vertical?.onChange(4.5))
    expect(updateSettings).toHaveBeenNthCalledWith(1, { terminalPaddingX: 4 })
    expect(updateSettings).toHaveBeenNthCalledWith(2, { terminalPaddingY: 5 })
  })
})
