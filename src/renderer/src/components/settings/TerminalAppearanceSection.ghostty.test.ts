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
  isWindowsUserAgent: () => false
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
  SettingsRow: function SettingsRow({ children }: { children?: unknown }) {
    return children
  },
  NumberField: function NumberField() {
    return null
  },
  FontAutocomplete: function FontAutocomplete() {
    return null
  },
  SettingsSegmentedControl: function SettingsSegmentedControl({
    options
  }: {
    options?: readonly { label: string }[]
  }) {
    return options?.map((option) => option.label) ?? null
  },
  SettingsSubsectionHeader: function SettingsSubsectionHeader() {
    return null
  },
  SettingsSwitchRow: function SettingsSwitchRow() {
    return null
  }
}))

vi.mock('./TerminalThemeSections', () => ({
  DarkTerminalThemeSection: function DarkTerminalThemeSection() {
    return null
  },
  LightTerminalThemeSection: function LightTerminalThemeSection() {
    return null
  },
  TerminalThemeImportSection: function TerminalThemeImportSection() {
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

vi.mock('./WarpThemeImportModal', () => ({
  WarpThemeImportModal: function WarpThemeImportModal() {
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

const warpThemesMock = {
  open: true,
  mode: 'warp' as const,
  preview: {
    found: true,
    sourceLabel: 'themes',
    themes: [],
    skippedFiles: []
  },
  loading: false,
  desktopOnly: false,
  applyError: null,
  importSignal: 0,
  selectedThemeIds: new Set<string>(),
  handleClick: vi.fn(),
  handleImportYamlClick: vi.fn(),
  handlePreviewSource: vi.fn(),
  handleToggleTheme: vi.fn(),
  handleToggleAll: vi.fn(),
  handleApply: vi.fn(),
  handleOpenChange: vi.fn()
}

import { TerminalAppearanceSection } from './TerminalAppearanceSection'

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
    if (typeName === 'GhosttyImportButton' || typeName === 'WarpThemeImportButton') {
      traverse((el.type as (props: Record<string, unknown>) => unknown)(el.props))
      return
    }
    if (typeName === 'Button') {
      const text = extractText(el.props.children)
      buttons.push({ text, onClick: el.props.onClick as (() => void) | undefined })
    }
    // Why: appearance controls were split into subcomponents; expand them so
    // this wiring test can still find nested buttons without a full render tree.
    if (typeof el.type === 'function' && typeName !== 'Button') {
      try {
        traverse((el.type as (props: Record<string, unknown>) => unknown)(el.props))
      } catch {
        // Ignore components that need runtime context the test does not provide.
      }
    }
    if (el.props?.children) {
      traverse(el.props.children)
    }
  }

  traverse(node)
  return buttons
}

function findDarkTerminalThemeSection(node: unknown): ReactElementLike | null {
  if (node == null) {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDarkTerminalThemeSection(child)
      if (found) {
        return found
      }
    }
    return null
  }
  const el = node as ReactElementLike
  const typeName = typeof el.type === 'function' ? el.type.name : String(el.type)
  if (typeName === 'DarkTerminalThemeSection') {
    return el
  }
  if (el.props?.children) {
    return findDarkTerminalThemeSection(el.props.children)
  }
  return null
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

function findTerminalThemeImportSection(node: unknown): ReactElementLike | null {
  if (node == null) {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTerminalThemeImportSection(child)
      if (found) {
        return found
      }
    }
    return null
  }
  const el = node as ReactElementLike
  const typeName = typeof el.type === 'function' ? el.type.name : String(el.type)
  if (typeName === 'TerminalThemeImportSection') {
    return el
  }
  if (el.props?.children) {
    return findTerminalThemeImportSection(el.props.children)
  }
  return null
}

function findWarpThemeImportModal(node: unknown): ReactElementLike | null {
  if (node == null) {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findWarpThemeImportModal(child)
      if (found) {
        return found
      }
    }
    return null
  }
  const el = node as ReactElementLike
  const typeName = typeof el.type === 'function' ? el.type.name : String(el.type)
  if (typeName === 'WarpThemeImportModal') {
    return el
  }
  if (el.props?.children) {
    return findWarpThemeImportModal(el.props.children)
  }
  return null
}

describe('TerminalAppearanceSection ghostty import wiring', () => {
  beforeEach(() => {
    mockStateValues.length = 0
    resetMockState()
    vi.unstubAllGlobals()
    vi.stubGlobal('window', { location: { pathname: '/index.html' } })
    vi.clearAllMocks()
  })

  it('renders the Import from Ghostty button with terminal appearance controls', () => {
    const element = TerminalAppearanceSection({
      settings: {} as never,
      updateSettings: () => {},
      systemPrefersDark: true,
      terminalFontSuggestions: [],
      ghostty: ghosttyMock,
      warpThemes: warpThemesMock
    })

    const buttons = findButtons(element)
    const importButton = buttons.find((b) => b.text === 'Import from Ghostty')
    expect(importButton).toBeDefined()

    importButton?.onClick?.()
    expect(ghosttyMock.handleClick).toHaveBeenCalled()
  })

  it('renders the shared theme import section above the theme pickers on desktop', () => {
    const element = TerminalAppearanceSection({
      settings: {} as never,
      updateSettings: () => {},
      systemPrefersDark: true,
      terminalFontSuggestions: [],
      ghostty: ghosttyMock,
      warpThemes: warpThemesMock
    })

    // Why: imports land in one pool shared by both pickers, so the buttons
    // live in their own section rather than inside the Dark Theme section.
    const buttons = findButtons(element)
    expect(buttons.some((button) => button.text === 'Import themes from Warp')).toBe(false)

    const importSection = findTerminalThemeImportSection(element)
    expect(importSection?.props.warpThemes).toBe(warpThemesMock)
    expect(findDarkTerminalThemeSection(element)).not.toBeNull()
  })

  it('hides the theme import affordance on paired web clients', () => {
    vi.stubGlobal('window', {
      __ORCA_WEB_CLIENT__: true,
      location: { pathname: '/web-index.html' }
    })

    const element = TerminalAppearanceSection({
      settings: {} as never,
      updateSettings: () => {},
      systemPrefersDark: true,
      terminalFontSuggestions: [],
      ghostty: ghosttyMock,
      warpThemes: warpThemesMock
    })

    expect(findTerminalThemeImportSection(element)).toBeNull()
    expect(findWarpThemeImportModal(element)).toBeNull()
  })

  it('passes hook state to GhosttyImportModal', () => {
    const element = TerminalAppearanceSection({
      settings: {} as never,
      updateSettings: () => {},
      systemPrefersDark: true,
      terminalFontSuggestions: [],
      ghostty: ghosttyMock,
      warpThemes: warpThemesMock
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

  it('passes hook state to WarpThemeImportModal', () => {
    const element = TerminalAppearanceSection({
      settings: {} as never,
      updateSettings: () => {},
      systemPrefersDark: true,
      terminalFontSuggestions: [],
      ghostty: ghosttyMock,
      warpThemes: warpThemesMock
    })

    const modal = findWarpThemeImportModal(element)
    expect(modal).not.toBeNull()
    expect(modal?.props.open).toBe(warpThemesMock.open)
    expect(modal?.props.preview).toEqual(warpThemesMock.preview)
    expect(modal?.props.loading).toBe(warpThemesMock.loading)
    expect(modal?.props.desktopOnly).toBe(false)
    expect(modal?.props.handleApply).toBe(warpThemesMock.handleApply)
    expect(modal?.props.handleOpenChange).toBe(warpThemesMock.handleOpenChange)
  })
})
