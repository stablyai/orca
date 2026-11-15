// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ShortcutsPane } from './ShortcutsPane'

vi.hoisted(() => vi.stubGlobal('navigator', { userAgent: 'Macintosh' }))
const fixtures = vi.hoisted(() => ({ empty: [] }))
vi.mock('@/store/plugins/catalog/plugin-contribution-catalog', () => ({
  useEditablePluginCommands: () => fixtures.empty
}))
vi.mock('./use-mac-captured-digit-chords', () => ({
  useMacCapturedDigitChords: () => fixtures.empty
}))
vi.mock('./KeybindingsFileActions', () => ({ KeybindingsFileActions: () => null }))
vi.mock('./ShortcutTerminalPolicyControl', () => ({ ShortcutTerminalPolicyControl: () => null }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderPaneWithConflict(): Promise<HTMLElement> {
  useAppStore.setState({
    keybindings: { 'worktree.palette': ['Mod+J'], 'terminal.clear': ['Mod+K'] },
    keybindingSnapshot: null
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
  expect(screen.queryByText(/conflicts with/)).not.toBeNull()
  return recorder
}

it('keeps recording across a window switch and stops on a click elsewhere, keeping the error', async () => {
  const setShortcutRecorderFocused = vi.fn()
  vi.stubGlobal('api', { ui: { setShortcutRecorderFocused } })
  const recorder = await renderPaneWithConflict()
  const errorNode = screen.getByText(/conflicts with/)

  // Window/app switch: the recorder blurs but gets focus back on return, so it keeps listening.
  act(() => recorder.blur())
  expect(recorder.getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(document.body)

  expect(recorder.getAttribute('aria-pressed')).toBe('false')
  expect(setShortcutRecorderFocused).toHaveBeenLastCalledWith(false)
  expect(errorNode.isConnected).toBe(true)
  expect(screen.queryByText('Press another shortcut, or Esc to cancel.')).toBeNull()
})

it('clears a click-away error when another recorder starts', async () => {
  vi.stubGlobal('api', { ui: { setShortcutRecorderFocused: vi.fn() } })
  const first = await renderPaneWithConflict()
  const second = screen.getByRole('button', { name: 'Change shortcut for Clear active pane' })

  act(() => second.focus())
  expect(first.getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(second)
  expect(first.getAttribute('aria-pressed')).toBe('false')
  expect(second.getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByText(/conflicts with/)).toBeNull()

  // A second click on the active recorder must not cancel it.
  fireEvent.click(second)
  expect(second.getAttribute('aria-pressed')).toBe('true')
})
