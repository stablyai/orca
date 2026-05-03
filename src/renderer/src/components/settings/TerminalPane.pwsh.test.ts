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

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useDetectedOptionAsAlt: () => 'us'
}))

vi.mock('@/lib/keyboard-layout/detect-option-as-alt', () => ({
  detectedCategoryToDefault: () => 'left-option'
}))

vi.mock('@/components/terminal-pane/pane-helpers', () => ({
  isMacUserAgent: () => false,
  isWindowsUserAgent: () => true
}))

vi.mock('../ui/button', () => ({
  Button: function Button() {
    return null
  }
}))

vi.mock('../ui/input', () => ({
  Input: function Input() {
    return null
  }
}))

vi.mock('../ui/label', () => ({
  Label: function Label() {
    return null
  }
}))

vi.mock('../ui/separator', () => ({
  Separator: function Separator() {
    return null
  }
}))

vi.mock('../ui/toggle-group', () => ({
  ToggleGroup: function ToggleGroup() {
    return null
  },
  ToggleGroupItem: function ToggleGroupItem() {
    return null
  }
}))

vi.mock('./SettingsFormControls', () => ({
  NumberField: function NumberField() {
    return null
  },
  FontAutocomplete: function FontAutocomplete() {
    return null
  }
}))

vi.mock('./TerminalThemeSections', () => ({
  DarkTerminalThemeSection: function DarkTerminalThemeSection() {
    return null
  },
  LightTerminalThemeSection: function LightTerminalThemeSection() {
    return null
  }
}))

vi.mock('./TerminalWindowSection', () => ({
  TerminalWindowSection: function TerminalWindowSection() {
    return null
  }
}))

vi.mock('./GhosttyImportModal', () => ({
  GhosttyImportModal: function GhosttyImportModal() {
    return null
  }
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
  open: false,
  preview: null,
  loading: false,
  applied: false,
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

function collectText(node: unknown): string {
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
    return node.map(collectText).join('')
  }
  const el = node as ReactElementLike
  return collectText(el.props?.children)
}

function findAnchorByText(node: unknown, text: string): ReactElementLike | null {
  if (node == null) {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findAnchorByText(child, text)
      if (found) {
        return found
      }
    }
    return null
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return null
  }
  const el = node as ReactElementLike
  const typeName = typeof el.type === 'function' ? el.type.name : String(el.type)
  if (typeName === 'a' && collectText(el.props.children).includes(text)) {
    return el
  }
  return findAnchorByText(el.props?.children, text)
}

describe('TerminalPane PowerShell version setting', () => {
  beforeEach(() => {
    mockStateValues.length = 0
    resetMockState()
    vi.clearAllMocks()
  })

  it('shows the PowerShell 7+ download link when pwsh is unavailable', () => {
    const element = TerminalPane({
      settings: {
        terminalScrollbackBytes: 10_000_000,
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'powershell.exe',
        terminalWordSeparator: ''
      } as never,
      updateSettings: () => {},
      systemPrefersDark: true,
      terminalFontSuggestions: [],
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      ghostty: ghosttyMock,
      wslAvailable: false,
      pwshAvailable: false
    })

    expect(collectText(element)).toContain('Auto uses Windows PowerShell now')
    const link = findAnchorByText(element, 'Download PowerShell 7+')
    expect(link).not.toBeNull()
    expect(link?.props.href).toBe('https://github.com/PowerShell/PowerShell/releases/latest')
  })
})
