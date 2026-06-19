/* oxlint-disable max-lines -- Why: TerminalPane tests share a large mocked
   settings harness; splitting the new Windows-shell cases would duplicate
   brittle React/store mocks without improving coverage. */
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
  SettingsRow: function SettingsRow({
    description,
    control,
    children
  }: {
    description?: unknown
    control?: unknown
    children?: unknown
  }) {
    return [description, control, children]
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
  SettingsSubsectionHeader: function SettingsSubsectionHeader({
    title,
    description
  }: {
    title?: unknown
    description?: unknown
  }) {
    return [title, description]
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

vi.mock('./ManageSessionsSection', () => ({
  ManageSessionsSection: function ManageSessionsSection() {
    return null
  }
}))

vi.mock('./TerminalInteractionSection', () => ({
  TerminalInteractionSection: function TerminalInteractionSection() {
    return null
  }
}))

vi.mock('./TerminalRenderingSection', () => ({
  TerminalRenderingSection: function TerminalRenderingSection() {
    return null
  }
}))

vi.mock('./TerminalSetupScriptSection', () => ({
  TerminalSetupScriptSection: function TerminalSetupScriptSection() {
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

import { TerminalPane } from './TerminalPane'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function getPropNodes(el: ReactElementLike): unknown[] {
  const nodes = [el.props?.children, el.props?.description, el.props?.control]
  const options = el.props?.options
  if (Array.isArray(options)) {
    nodes.push(options.map((option) => (option as { label?: unknown }).label))
  }
  return nodes
}

function renderFunctionElement(el: ReactElementLike): unknown {
  return typeof el.type === 'function' ? el.type(el.props) : undefined
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
  const rendered = renderFunctionElement(el)
  if (rendered !== undefined) {
    return collectText(rendered)
  }
  return getPropNodes(el).map(collectText).join('')
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
  const rendered = renderFunctionElement(el)
  if (rendered !== undefined) {
    return findAnchorByText(rendered, text)
  }
  for (const child of getPropNodes(el)) {
    const found = findAnchorByText(child, text)
    if (found) {
      return found
    }
  }
  return null
}

function hasShellIconFor(node: unknown, shell: string): boolean {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return false
  }
  if (Array.isArray(node)) {
    return node.some((child) => hasShellIconFor(child, shell))
  }
  const el = node as ReactElementLike
  const typeName = typeof el.type === 'function' ? el.type.name : String(el.type)
  if (typeName === 'ShellIcon' && el.props.shell === shell) {
    return true
  }
  const rendered = renderFunctionElement(el)
  if (rendered !== undefined) {
    return hasShellIconFor(rendered, shell)
  }
  return getPropNodes(el).some((child) => hasShellIconFor(child, shell))
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
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      wslAvailable: false,
      pwshAvailable: false,
      gitBashAvailable: false
    })

    expect(collectText(element)).toContain('Auto uses Windows PowerShell now')
    const link = findAnchorByText(element, 'Download PowerShell 7+')
    expect(link).not.toBeNull()
    expect(link?.props.href).toBe('https://github.com/PowerShell/PowerShell/releases/latest')
  })

  it('does not show WSL as a Windows default shell option when available', () => {
    const element = TerminalPane({
      settings: {
        terminalScrollbackBytes: 10_000_000,
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'auto',
        terminalWordSeparator: ''
      } as never,
      updateSettings: () => {},
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: false,
      gitBashAvailable: false
    })

    const text = collectText(element)
    expect(text).toContain('PowerShell')
    expect(text).toContain('Command Prompt')
    expect(text).not.toContain('WSL')
  })

  it('shows Windows shell controls for a remote Windows host on a non-Windows client', () => {
    const element = TerminalPane({
      settings: {
        terminalScrollbackBytes: 10_000_000,
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'auto',
        terminalWordSeparator: ''
      } as never,
      updateSettings: () => {},
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: false,
      gitBashAvailable: false,
      isWindowsTerminalHost: true
    })

    const text = collectText(element)
    expect(text).toContain('Default shell for new terminal panes on Windows')
    expect(text).toContain('Command Prompt')
    expect(text).not.toContain('WSL')
  })

  it('hides WSL as a Windows default shell option when unavailable', () => {
    const element = TerminalPane({
      settings: {
        terminalScrollbackBytes: 10_000_000,
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'auto',
        terminalWordSeparator: ''
      } as never,
      updateSettings: () => {},
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      wslAvailable: false,
      pwshAvailable: false,
      gitBashAvailable: false
    })

    expect(collectText(element)).not.toContain('WSL')
  })

  it('does not show WSL distro choices for a persisted legacy WSL shell', () => {
    const element = TerminalPane({
      settings: {
        terminalScrollbackBytes: 10_000_000,
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        terminalWindowsPowerShellImplementation: 'auto',
        terminalWordSeparator: ''
      } as never,
      updateSettings: () => {},
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      wslAvailable: true,
      wslDistros: ['Ubuntu', 'Debian'],
      pwshAvailable: false,
      gitBashAvailable: false
    })

    const text = collectText(element)
    expect(text).toContain('PowerShell')
    expect(text).toContain('Command Prompt')
    expect(text).not.toContain('Choose which WSL distribution')
    expect(text).not.toContain('Windows default')
    expect(text).not.toContain('Ubuntu')
    expect(text).not.toContain('Debian')
  })

  it('shows Git Bash as a Windows default shell option when bash.exe is detected', () => {
    const element = TerminalPane({
      settings: {
        terminalScrollbackBytes: 10_000_000,
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'auto',
        terminalWordSeparator: ''
      } as never,
      updateSettings: () => {},
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      wslAvailable: false,
      pwshAvailable: false,
      gitBashAvailable: true
    })

    expect(collectText(element)).toContain('Git Bash')
    expect(hasShellIconFor(element, 'git-bash')).toBe(true)
  })

  it('hides Git Bash as a Windows default shell option when not detected', () => {
    const element = TerminalPane({
      settings: {
        terminalScrollbackBytes: 10_000_000,
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'auto',
        terminalWordSeparator: ''
      } as never,
      updateSettings: () => {},
      scrollbackMode: 'preset',
      setScrollbackMode: () => {},
      wslAvailable: false,
      pwshAvailable: false,
      gitBashAvailable: false
    })

    expect(collectText(element)).not.toContain('Git Bash')
  })
})
