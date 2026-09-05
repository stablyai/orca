// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const replay = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ repos: [] }) } }))
vi.mock('./layout-serialization', () => ({
  replayTerminalLayout: replay,
  restoreScrollbackBuffers: vi.fn()
}))
vi.mock('./expand-collapse', () => ({ applyExpandedLayoutTo: vi.fn() }))
vi.mock('./terminal-pane-lifecycle-primitives', () => ({
  replayLayoutWithOneShotParkIntent: (_deps: unknown, restore: () => unknown) => restore(),
  mapRestoredPaneTitlesByPaneId: () => ({})
}))
import { restoreTerminalPaneLayout } from './terminal-pane-layout-restore'

type RestoreArgs = Parameters<typeof restoreTerminalPaneLayout>[0]

function restore(isActive: boolean) {
  const manager = { setActivePane: vi.fn(), getPanes: () => [{ id: 7 }] }
  const layout = { activeLeafId: 'leaf' }
  const result = restoreTerminalPaneLayout({
    manager: manager as unknown as RestoreArgs['manager'],
    deps: {
      initialLayoutRef: { current: layout },
      tabId: 'tab',
      worktreeId: 'workspace',
      isActive,
      managerRef: { current: manager },
      replayingPanesRef: { current: new Set() },
      setExpandedPane: vi.fn()
    } as unknown as RestoreArgs['deps'],
    refs: { restoredViewportBlankingPanesRef: { current: new Set() } } as RestoreArgs['refs'],
    ptyDeps: {} as RestoreArgs['ptyDeps'],
    initialLayoutHadBuffers: false
  })
  expect(result.get('leaf')).toBe(7)
  return { manager, layout }
}

beforeEach(() => {
  vi.clearAllMocks()
  replay.mockReturnValue(new Map([['leaf', 7]]))
})
afterEach(() => {
  document.body.replaceChildren()
})

describe('terminal layout restoration focus ownership', () => {
  it.each(['textarea', 'input', 'select'] as const)(
    'preserves a focused %s when the active workspace terminal appears',
    (tag) => {
      const editor = document.createElement(tag)
      document.body.append(editor)
      editor.focus()
      expect(document.activeElement).toBe(editor)
      const { manager, layout } = restore(true)
      expect(replay).toHaveBeenCalledExactlyOnceWith(manager, layout, false)
      expect(manager.setActivePane).toHaveBeenCalledExactlyOnceWith(7, { focus: false })
      expect(document.activeElement).toBe(editor)
    }
  )

  it('preserves a focused contenteditable editor', () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    editor.tabIndex = 0
    document.body.append(editor)
    editor.focus()
    expect(document.activeElement).toBe(editor)
    const { manager, layout } = restore(true)
    expect(replay).toHaveBeenCalledExactlyOnceWith(manager, layout, false)
    expect(manager.setActivePane).toHaveBeenCalledExactlyOnceWith(7, { focus: false })
  })

  it('focuses the active terminal when the body holds focus', () => {
    expect(document.activeElement).toBe(document.body)
    const { manager, layout } = restore(true)
    expect(replay).toHaveBeenCalledExactlyOnceWith(manager, layout, true)
    expect(manager.setActivePane).toHaveBeenCalledExactlyOnceWith(7, { focus: true })
  })

  it('allows terminal focus when xterm owns its editable input', () => {
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const input = document.createElement('textarea')
    input.className = 'xterm-helper-textarea'
    terminal.append(input)
    document.body.append(terminal)
    input.focus()
    expect(document.activeElement).toBe(input)
    const { manager, layout } = restore(true)
    expect(replay).toHaveBeenCalledExactlyOnceWith(manager, layout, true)
    expect(manager.setActivePane).toHaveBeenCalledExactlyOnceWith(7, { focus: true })
  })

  it('never requests focus for an inactive terminal', () => {
    expect(document.activeElement).toBe(document.body)
    const { manager, layout } = restore(false)
    expect(replay).toHaveBeenCalledExactlyOnceWith(manager, layout, false)
    expect(manager.setActivePane).toHaveBeenCalledExactlyOnceWith(7, { focus: false })
  })
})
