// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ShortcutsPane } from './ShortcutsPane'

vi.hoisted(() => vi.stubGlobal('navigator', { userAgent: 'Macintosh' }))
const fixtures = vi.hoisted(() => ({ empty: [] }))
vi.mock('@/store/plugin-panels', () => ({ useEditablePluginCommands: () => fixtures.empty }))
vi.mock('./use-mac-captured-digit-chords', () => ({
  useMacCapturedDigitChords: () => fixtures.empty
}))
vi.mock('./KeybindingsFileActions', () => ({ KeybindingsFileActions: () => null }))
vi.mock('./ShortcutTerminalPolicyControl', () => ({ ShortcutTerminalPolicyControl: () => null }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps recording when the current default conflicts with an explicit shortcut in a legacy profile', async () => {
  vi.stubGlobal('api', { ui: { setShortcutRecorderFocused: vi.fn() } })
  useAppStore.setState({
    keybindings: { 'worktree.palette': ['Mod+J'], 'terminal.clear': ['Mod+K'] },
    keybindingSnapshot: {
      path: '/tmp/keybindings.json',
      exists: true,
      platform: 'darwin',
      overrides: { 'worktree.palette': ['Mod+J'], 'terminal.clear': ['Mod+K'] },
      defaultOverrides: { 'worktree.palette': ['Mod+J'], 'terminal.clear': ['Mod+K'] },
      commonOverrides: {},
      platformOverrides: { darwin: { 'terminal.clear': ['Mod+K'] } },
      diagnostics: []
    },
    resetKeybindingOverride: vi.fn().mockResolvedValue(undefined),
    setKeybindingOverride: vi.fn().mockResolvedValue(undefined)
  })
  render(
    <TooltipProvider>
      <ShortcutsPane />
    </TooltipProvider>
  )
  const recorder = screen.getByRole('button', { name: 'Change shortcut for Switch worktree' })
  fireEvent.click(recorder)
  await act(async () => {
    fireEvent.keyDown(recorder, { key: 'k', code: 'KeyK', metaKey: true })
  })
  expect(recorder.getAttribute('aria-pressed')).toBe('true')
})
