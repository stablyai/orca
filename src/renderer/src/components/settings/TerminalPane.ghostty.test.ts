import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockStateValues: unknown[] = []
let mockStateIndex = 0

function resetMockState() {
  mockStateIndex = 0
}

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = mockStateIndex++
      if (mockStateValues[i] === undefined) {
        mockStateValues[i] = initial
      }
      const setter = (v: unknown) => {
        mockStateValues[i] = v
      }
      return [mockStateValues[i], setter]
    },
    useCallback: (fn: () => void) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useSyncExternalStore: (_subscribe: () => () => void, getSnapshot: () => unknown) =>
      getSnapshot()
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useDetectedOptionAsAlt: () => 'us'
}))

vi.mock('@/components/terminal-pane/pane-helpers', () => ({
  isMacUserAgent: () => false,
  isWindowsUserAgent: () => false
}))

vi.mock('@/lib/terminal-theme', () => ({
  clampNumber: (v: number, min: number, max: number) => Math.max(min, Math.min(max, v)),
  resolveEffectiveTerminalAppearance: () => ({
    mode: 'dark',
    themeName: 'test',
    dividerColor: '#000',
    theme: null,
    systemPrefersDark: true,
    sourceTheme: 'dark'
  }),
  resolvePaneStyleOptions: () => ({ inactivePaneOpacity: 0.8, dividerThicknessPx: 1 })
}))

const ghosttyMock = {
  open: true,
  preview: {
    found: true,
    configPath: '/path',
    diff: { terminalFontSize: 14 },
    unsupportedKeys: []
  },
  loading: false,
  applied: true,
  applyError: null,
  handleClick: vi.fn(),
  handleApply: vi.fn(),
  handleOpenChange: vi.fn()
}

import { TerminalPane } from './TerminalPane'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function extractText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string') {
    return node
  }
  if (typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('')
  }
  const el = node as ReactElementLike
  if (el.props?.children) {
    return extractText(el.props.children)
  }
  return ''
}

function findButtons(node: unknown): { text: string; onClick: (() => void) | undefined }[] {
  const buttons: { text: string; onClick: (() => void) | undefined }[] = []

  function traverse(n: unknown): void {
    if (n == null) {
      return
    }
    if (typeof n === 'string' || typeof n === 'number') {
      return
    }
    if (Array.isArray(n)) {
      n.forEach(traverse)
      return
    }
    const el = n as ReactElementLike
    const typeName = typeof el.type === 'function' ? el.type.name : String(el.type)
    if (typeName === 'Button') {
      const text = extractText(el.props.children)
      buttons.push({ text, onClick: el.props.onClick as (() => void) | undefined })
    }
    if (el.props?.children) {
      traverse(el.props.children)
    }
  }

  traverse(node)
  return buttons
}

function findGhosttyImportModal(node: unknown): ReactElementLike | null {
  if (node == null) {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findGhosttyImportModal(child)
      if (found) {
        return found
      }
    }
    return null
  }
  const el = node as ReactElementLike
  const typeName = typeof el.type === 'function' ? el.type.name : String(el.type)
  if (typeName === 'GhosttyImportModal') {
    return el
  }
  if (el.props?.children) {
    return findGhosttyImportModal(el.props.children)
  }
  return null
}

describe('TerminalPane ghostty import wiring', () => {
  beforeEach(() => {
    mockStateValues.length = 0
    resetMockState()
    vi.clearAllMocks()
  })

  // Why: the Ghostty import trigger button lives on the section header in
  // Settings.tsx (headerAction) — not inside TerminalPane. Keep this test
  // around so a regression that moves the button back into the pane fails.
  it('does not render an Import from Ghostty button inside the pane', () => {
    const element = TerminalPane({
      settings: {} as never,
      updateSettings: () => {},
      systemPrefersDark: true,
      terminalFontSuggestions: [],
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      ghostty: ghosttyMock
    })

    const buttons = findButtons(element)
    const importButton = buttons.find((b) => b.text === 'Import from Ghostty')
    expect(importButton).toBeUndefined()
  })

  it('passes hook state to GhosttyImportModal', () => {
    const element = TerminalPane({
      settings: {} as never,
      updateSettings: () => {},
      systemPrefersDark: true,
      terminalFontSuggestions: [],
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      ghostty: ghosttyMock
    })

    const modal = findGhosttyImportModal(element)
    expect(modal).not.toBeNull()
    expect(modal?.props.open).toBe(ghosttyMock.open)
    expect(modal?.props.preview).toEqual(ghosttyMock.preview)
    expect(modal?.props.loading).toBe(ghosttyMock.loading)
    expect(modal?.props.applied).toBe(ghosttyMock.applied)
    expect(modal?.props.onApply).toBe(ghosttyMock.handleApply)
    expect(modal?.props.onOpenChange).toBe(ghosttyMock.handleOpenChange)
  })
})
