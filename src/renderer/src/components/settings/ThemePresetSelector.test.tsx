// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemePresetSelector } from './ThemePresetSelector'

describe('ThemePresetSelector', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount()
      })
    }
    container?.remove()
    container = null
    root = null
  })

  it('renders dark presets when effectiveMode is dark', () => {
    const onChange = vi.fn()
    act(() => {
      root?.render(<ThemePresetSelector value="default" onChange={onChange} effectiveMode="dark" />)
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    expect(buttons?.length).toBeGreaterThanOrEqual(7)

    const draculaBtn = Array.from(buttons ?? []).find((b) => b.textContent?.includes('Dracula'))
    expect(draculaBtn).toBeDefined()

    const materialDarkBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Material 3 Dark')
    )
    expect(materialDarkBtn).toBeDefined()

    const liquidGlassDarkBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('iOS 27 Liquid Glass Dark')
    )
    expect(liquidGlassDarkBtn).toBeDefined()

    const dalaDarkBtn = Array.from(buttons ?? []).find((b) => b.textContent?.includes('Dala Dark'))
    expect(dalaDarkBtn).toBeDefined()

    const discordDarkBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Discord Dark')
    )
    expect(discordDarkBtn).toBeDefined()

    const dopeDarkBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Dope Security Dark')
    )
    expect(dopeDarkBtn).toBeDefined()

    const raycastDarkBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Raycast Dark')
    )
    expect(raycastDarkBtn).toBeDefined()

    const zkpassDarkBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('zkPass Dark')
    )
    expect(zkpassDarkBtn).toBeDefined()

    const mirandaDarkBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Miranda Ink')
    )
    expect(mirandaDarkBtn).toBeDefined()
  })

  it('renders light presets when effectiveMode is light', () => {
    const onChange = vi.fn()
    act(() => {
      root?.render(
        <ThemePresetSelector value="default" onChange={onChange} effectiveMode="light" />
      )
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    const latteBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Catppuccin Latte')
    )
    expect(latteBtn).toBeDefined()

    const materialLightBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Material 3 Light')
    )
    expect(materialLightBtn).toBeDefined()

    const liquidGlassLightBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('iOS 27 Liquid Glass Light')
    )
    expect(liquidGlassLightBtn).toBeDefined()

    const dalaLightBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Dala Light')
    )
    expect(dalaLightBtn).toBeDefined()

    const discordLightBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Discord Light')
    )
    expect(discordLightBtn).toBeDefined()

    const dopeLightBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Dope Security Light')
    )
    expect(dopeLightBtn).toBeDefined()

    const raycastLightBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Raycast Light')
    )
    expect(raycastLightBtn).toBeDefined()

    const zkpassLightBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('zkPass Light')
    )
    expect(zkpassLightBtn).toBeDefined()

    const mirandaLightBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Miranda Paper')
    )
    expect(mirandaLightBtn).toBeDefined()
  })

  it('calls onChange when clicking a preset', () => {
    const onChange = vi.fn()
    act(() => {
      root?.render(<ThemePresetSelector value="default" onChange={onChange} effectiveMode="dark" />)
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    const draculaBtn = Array.from(buttons ?? []).find((b) => b.textContent?.includes('Dracula'))

    expect(draculaBtn).toBeInstanceOf(HTMLButtonElement)
    if (draculaBtn instanceof HTMLButtonElement) {
      act(() => {
        draculaBtn.click()
      })
    }

    expect(onChange).toHaveBeenCalledWith('dracula')
  })

  it('sets aria-checked on selected preset', () => {
    act(() => {
      root?.render(<ThemePresetSelector value="nord" onChange={vi.fn()} effectiveMode="dark" />)
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    const nordBtn = Array.from(buttons ?? []).find((b) => b.textContent?.includes('Nord'))
    expect(nordBtn?.getAttribute('aria-checked')).toBe('true')
  })

  it('shows effective counterpart preset as checked when value belongs to opposite mode', () => {
    act(() => {
      root?.render(
        <ThemePresetSelector value="catppuccin-mocha" onChange={vi.fn()} effectiveMode="light" />
      )
    })

    const buttons = container?.querySelectorAll('button[role="radio"]')
    const latteBtn = Array.from(buttons ?? []).find((b) =>
      b.textContent?.includes('Catppuccin Latte')
    )
    expect(latteBtn?.getAttribute('aria-checked')).toBe('true')
  })
})
