// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { KeybindingOverrides } from '../../../shared/keybindings'

const platformRef = vi.hoisted(() => ({ current: 'darwin' as NodeJS.Platform }))

vi.mock('../lib/shortcut-platform', () => ({
  getShortcutPlatform: () => platformRef.current
}))

const { formatShortcutLabel, useShortcutLabel } = await import('./useShortcutLabel')
const { useAppStore } = await import('@/store')

// A fresh overrides object per test keeps each case on its own cache entry, exactly as a real edit does.
function overridesFor(binding: string): KeybindingOverrides {
  return { 'tab.close': [binding] }
}

describe('shortcut label memoization', () => {
  beforeEach(() => {
    platformRef.current = 'darwin'
  })

  it('keys the cache by platform so Mac and Windows glyphs never cross', () => {
    const overrides = overridesFor('Mod+Shift+K')
    expect(formatShortcutLabel('tab.close', overrides)).toBe('⌘⇧K')
    platformRef.current = 'win32'
    expect(formatShortcutLabel('tab.close', overrides)).toBe('Ctrl+⇧+K')
    platformRef.current = 'darwin'
    expect(formatShortcutLabel('tab.close', overrides)).toBe('⌘⇧K')
  })
})

function CloseLabel(): React.JSX.Element {
  return <span data-testid="close-label">{useShortcutLabel('tab.close')}</span>
}

describe('useShortcutLabel', () => {
  beforeEach(() => {
    platformRef.current = 'darwin'
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState({ keybindings: {} })
  })

  it('shows an edited keybinding immediately, with no stale-cache window', () => {
    useAppStore.setState({ keybindings: overridesFor('Mod+Shift+K') })
    render(<CloseLabel />)
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⇧K')

    act(() => useAppStore.setState({ keybindings: overridesFor('Mod+Shift+L') }))
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⇧L')

    act(() => useAppStore.setState({ keybindings: { 'tab.close': ['Mod+Alt+Backspace'] } }))
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⌥⌫')

    act(() => useAppStore.setState({ keybindings: { 'tab.close': [] } }))
    expect(screen.getByTestId('close-label').textContent).toBe('Unassigned')

    act(() => useAppStore.setState({ keybindings: overridesFor('Mod+Shift+K') }))
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⇧K')
  })
})
