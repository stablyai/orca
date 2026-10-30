// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ShortcutRowsList } from './ShortcutRowsList'
import { ShortcutsPane } from './ShortcutsPane'

vi.hoisted(() => vi.stubGlobal('navigator', { userAgent: 'Macintosh' }))
const fixtures = vi.hoisted(() => ({
  empty: [],
  chord: { key: 'j', code: 'KeyJ', metaKey: true, shiftKey: true }
}))
vi.mock('@/store/plugin-panels', () => ({ useEditablePluginCommands: () => fixtures.empty }))
vi.mock('./use-mac-captured-digit-chords', () => ({
  useMacCapturedDigitChords: () => fixtures.empty
}))
vi.mock('./KeybindingsFileActions', () => ({ KeybindingsFileActions: () => null }))
vi.mock('./ShortcutTerminalPolicyControl', () => ({ ShortcutTerminalPolicyControl: () => null }))
vi.mock('./ShortcutRowsList', () => ({
  ShortcutRowsList: (props: React.ComponentProps<typeof ShortcutRowsList>) => (
    <>
      <button onClick={() => props.onStartRecordingAt('terminal.toggleNativeChat', 0)}>
        Record
      </button>
      <button onClick={() => props.onCapture('terminal.toggleNativeChat', fixtures.chord)}>
        Capture
      </button>
      <span>{props.errors['terminal.toggleNativeChat']}</span>
    </>
  )
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('retyping a nominal default resets unless a common override requires an explicit conflicting mask', async () => {
  vi.stubGlobal('api', { ui: { setShortcutRecorderFocused: vi.fn() } })
  const reset = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockResolvedValue(undefined)
  const common = { 'terminal.toggleNativeChat': ['Mod+Alt+K'] }
  const keybindings = { ...common, 'worktree.navigateDown': ['Mod+Shift+J'] }
  useAppStore.setState({
    keybindings,
    keybindingSnapshot: null,
    resetKeybindingOverride: reset,
    setKeybindingOverride: set
  })
  render(<ShortcutsPane />)
  fireEvent.click(screen.getByText('Record'))
  await act(async () => fireEvent.click(screen.getByText('Capture')))
  expect(reset).toHaveBeenCalledWith('terminal.toggleNativeChat')
  reset.mockClear()
  act(() =>
    useAppStore.setState({
      keybindingSnapshot: {
        path: '/tmp/pr31679-keybindings.json',
        exists: true,
        platform: 'darwin',
        overrides: keybindings,
        commonOverrides: common,
        platformOverrides: {},
        diagnostics: []
      }
    })
  )
  fireEvent.click(screen.getByText('Record'))
  await act(async () => fireEvent.click(screen.getByText('Capture')))
  expect(screen.getByText(/conflicts with/)).toBeTruthy()
  expect(reset).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()
})
