// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type * as KeybindingsModule from '../../../shared/keybindings'
import type { KeybindingOverrides } from '../../../shared/keybindings'

const counters = vi.hoisted(() => ({ effective: 0, formatList: 0, formatBinding: 0 }))
const platformRef = vi.hoisted(() => ({ current: 'darwin' as NodeJS.Platform }))

vi.mock('../lib/shortcut-platform', () => ({
  getShortcutPlatform: () => platformRef.current
}))

vi.mock('../../../shared/keybindings', async (importOriginal) => {
  const actual = await importOriginal<typeof KeybindingsModule>()
  return {
    ...actual,
    getEffectiveKeybindingsForAction: (
      ...args: Parameters<typeof actual.getEffectiveKeybindingsForAction>
    ) => {
      counters.effective++
      return actual.getEffectiveKeybindingsForAction(...args)
    },
    formatKeybindingList: (...args: Parameters<typeof actual.formatKeybindingList>) => {
      counters.formatList++
      return actual.formatKeybindingList(...args)
    },
    formatKeybinding: (...args: Parameters<typeof actual.formatKeybinding>) => {
      counters.formatBinding++
      return actual.formatKeybinding(...args)
    }
  }
})

const {
  formatOptionalShortcutLabel,
  formatPrimaryShortcutLabel,
  formatShortcutKeyComboDetails,
  formatShortcutLabel,
  useShortcutLabel
} = await import('./useShortcutLabel')
const { useAppStore } = await import('@/store')

function resetCounters(): void {
  counters.effective = 0
  counters.formatList = 0
  counters.formatBinding = 0
}

// A fresh overrides object per test keeps each case on its own cache entry, exactly as a real edit does.
function overridesFor(binding: string): KeybindingOverrides {
  return { 'tab.close': [binding] }
}

describe('shortcut label memoization', () => {
  beforeEach(() => {
    platformRef.current = 'darwin'
    resetCounters()
  })

  it('computes a label once no matter how many times it is asked for', () => {
    const overrides = overridesFor('Mod+Shift+K')
    const first = formatShortcutLabel('tab.close', overrides)
    resetCounters()
    for (let index = 0; index < 200; index++) {
      expect(formatShortcutLabel('tab.close', overrides)).toBe(first)
    }
    expect(counters.effective).toBe(0)
    expect(counters.formatList).toBe(0)
  })

  it('memoizes each label shape separately and keeps their values correct', () => {
    const overrides = overridesFor('Mod+Shift+K')
    expect(formatShortcutLabel('tab.close', overrides)).toBe(
      formatShortcutLabel('tab.close', overrides)
    )
    expect(formatPrimaryShortcutLabel('tab.close', overrides)).toBe(
      formatPrimaryShortcutLabel('tab.close', overrides)
    )
    expect(formatOptionalShortcutLabel('tab.close', overrides)).toBe(
      formatOptionalShortcutLabel('tab.close', overrides)
    )
    expect(formatShortcutKeyComboDetails('tab.close', overrides)).toBe(
      formatShortcutKeyComboDetails('tab.close', overrides)
    )
    expect(formatShortcutKeyComboDetails('tab.close', overrides)[0]?.keys).toEqual(['⌘', '⇧', 'K'])
    expect(formatShortcutLabel('tab.close', overrides)).toBe('⌘⇧K')
  })

  it('returns null rather than a cached sentinel for a disabled action', () => {
    const overrides: KeybindingOverrides = { 'tab.close': [] }
    expect(formatOptionalShortcutLabel('tab.close', overrides)).toBe(null)
    expect(formatOptionalShortcutLabel('tab.close', overrides)).toBe(null)
    expect(formatShortcutLabel('tab.close', overrides)).toBe('Unassigned')
    expect(formatPrimaryShortcutLabel('tab.close', overrides)).toBe('Unassigned')
  })

  it('recomputes as soon as a different overrides object arrives', () => {
    expect(formatShortcutLabel('tab.close', overridesFor('Mod+Shift+K'))).toBe('⌘⇧K')
    expect(formatShortcutLabel('tab.close', overridesFor('Mod+Shift+L'))).toBe('⌘⇧L')
    expect(formatShortcutLabel('tab.close', overridesFor('Mod+Shift+K'))).toBe('⌘⇧K')
  })

  it('does not let one action id serve another', () => {
    const overrides = overridesFor('Mod+Shift+K')
    expect(formatShortcutLabel('tab.close', overrides)).toBe('⌘⇧K')
    expect(formatShortcutLabel('tab.rename', overrides)).not.toBe('⌘⇧K')
  })

  it('keys the cache by platform so Mac and Windows glyphs never cross', () => {
    const overrides = overridesFor('Mod+Shift+K')
    expect(formatShortcutLabel('tab.close', overrides)).toBe('⌘⇧K')
    platformRef.current = 'win32'
    expect(formatShortcutLabel('tab.close', overrides)).toBe('Ctrl+Shift+K')
    platformRef.current = 'darwin'
    expect(formatShortcutLabel('tab.close', overrides)).toBe('⌘⇧K')
  })

  it('caches the undefined-overrides case without leaking into the override case', () => {
    const defaultLabel = formatShortcutLabel('tab.close')
    expect(formatShortcutLabel('tab.close')).toBe(defaultLabel)
    expect(formatShortcutLabel('tab.close', overridesFor('Mod+Shift+K'))).toBe('⌘⇧K')
    expect(formatShortcutLabel('tab.close')).toBe(defaultLabel)
  })
})

function CloseLabel(): React.JSX.Element {
  return <span data-testid="close-label">{useShortcutLabel('tab.close')}</span>
}

describe('useShortcutLabel', () => {
  beforeEach(() => {
    platformRef.current = 'darwin'
    resetCounters()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState({ keybindings: {} })
  })

  it('does not recompute the label on re-render', () => {
    useAppStore.setState({ keybindings: overridesFor('Mod+Shift+K') })
    const { rerender } = render(<CloseLabel />)
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⇧K')
    resetCounters()
    for (let index = 0; index < 25; index++) {
      rerender(<CloseLabel />)
    }
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⇧K')
    expect(counters.effective).toBe(0)
    expect(counters.formatList).toBe(0)
  })

  it('shows an edited keybinding immediately, with no stale-cache window', () => {
    useAppStore.setState({ keybindings: overridesFor('Mod+Shift+K') })
    render(<CloseLabel />)
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⇧K')

    // Mirrors the store update a Settings edit performs: a brand new overrides object.
    act(() => useAppStore.setState({ keybindings: overridesFor('Mod+Shift+L') }))
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⇧L')

    act(() => useAppStore.setState({ keybindings: { 'tab.close': ['Mod+Alt+Backspace'] } }))
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⌥⌫')

    act(() => useAppStore.setState({ keybindings: { 'tab.close': [] } }))
    expect(screen.getByTestId('close-label').textContent).toBe('Unassigned')

    // Back to the first binding: a revert must not resurrect the entry cached for the old object.
    act(() => useAppStore.setState({ keybindings: overridesFor('Mod+Shift+K') }))
    expect(screen.getByTestId('close-label').textContent).toBe('⌘⇧K')
  })
})
