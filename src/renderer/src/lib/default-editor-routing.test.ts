import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDefaultEditorShellCommand,
  normalizeDefaultEditorMode,
  openCustomEditorTerminalTab,
  quoteShellPathArgument,
  resolveDefaultEditorCustomCommand,
  resolveDefaultEditorMode,
  resolveTerminalPathForCommand,
  routeFileOpenToDefaultEditor
} from './default-editor-routing'

type MockStoreState = {
  settings: { defaultEditorMode?: string; defaultEditorCustomCommand?: string } | null
  activeGroupIdByWorktree: Record<string, string>
  createTab: ReturnType<typeof vi.fn>
  queueTabStartupCommand: ReturnType<typeof vi.fn>
  setActiveTab: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
  setTabBarOrder: ReturnType<typeof vi.fn>
  tabsByWorktree: Record<string, { id: string }[]>
  openFiles: { id: string; worktreeId: string }[]
  browserTabsByWorktree: Record<string, { id: string }[]>
  tabBarOrderByWorktree: Record<string, string[]>
}

let mockState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

function createStoreState(): MockStoreState {
  return {
    settings: null,
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    createTab: vi.fn(() => ({ id: 'tab-new' })),
    queueTabStartupCommand: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabBarOrder: vi.fn(),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-new' }] },
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {}
  }
}

function stubWindowApi(openFilePath: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('window', {
    ...(typeof window === 'undefined' ? {} : window),
    api: {
      platform: { get: () => ({ platform: 'linux' as const }) },
      shell: { openFilePath }
    }
  })
}

describe('normalizeDefaultEditorMode', () => {
  it('keeps valid modes and falls back to builtin otherwise', () => {
    expect(normalizeDefaultEditorMode('builtin')).toBe('builtin')
    expect(normalizeDefaultEditorMode('system')).toBe('system')
    expect(normalizeDefaultEditorMode('custom')).toBe('custom')
    expect(normalizeDefaultEditorMode('vscode')).toBe('builtin')
    expect(normalizeDefaultEditorMode(undefined)).toBe('builtin')
    expect(normalizeDefaultEditorMode(null)).toBe('builtin')
  })
})

describe('resolveDefaultEditorMode / resolveDefaultEditorCustomCommand', () => {
  it('resolves from settings with builtin defaults', () => {
    expect(resolveDefaultEditorMode(null)).toBe('builtin')
    expect(resolveDefaultEditorMode({} as never)).toBe('builtin')
    expect(resolveDefaultEditorMode({ defaultEditorMode: 'custom' } as never)).toBe('custom')
    expect(resolveDefaultEditorCustomCommand(null)).toBe('')
    expect(
      resolveDefaultEditorCustomCommand({
        defaultEditorCustomCommand: '  helix  '
      } as never)
    ).toBe('helix')
  })
})

describe('quoteShellPathArgument', () => {
  it('passes simple POSIX paths through unquoted', () => {
    expect(quoteShellPathArgument('/repo/src/main.ts', 'linux')).toBe('/repo/src/main.ts')
  })

  it('single-quotes POSIX paths with spaces', () => {
    expect(quoteShellPathArgument('/repo/my file.ts', 'linux')).toBe("'/repo/my file.ts'")
  })

  it('escapes single quotes inside POSIX paths', () => {
    expect(quoteShellPathArgument("/repo/it's.ts", 'linux')).toBe("'/repo/it'\\''s.ts'")
  })

  it('double-quotes Windows paths with spaces', () => {
    expect(quoteShellPathArgument('C:\\repo\\my file.ts', 'win32')).toBe('"C:\\repo\\my file.ts"')
  })

  it('passes simple Windows paths through unquoted', () => {
    expect(quoteShellPathArgument('C:\\repo\\main.ts', 'win32')).toBe('C:\\repo\\main.ts')
  })
})

describe('buildDefaultEditorShellCommand', () => {
  it('appends the quoted path to the command', () => {
    expect(buildDefaultEditorShellCommand('helix', '/repo/a b.ts', 'linux')).toBe(
      "helix '/repo/a b.ts'"
    )
    expect(buildDefaultEditorShellCommand('code -r', '/repo/a.ts', 'linux')).toBe(
      'code -r /repo/a.ts'
    )
  })
})

describe('resolveTerminalPathForCommand', () => {
  it('converts WSL UNC paths to linux paths for WSL worktrees', () => {
    expect(
      resolveTerminalPathForCommand(
        '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app.ts',
        '\\\\wsl.localhost\\Ubuntu\\home\\dev'
      )
    ).toBe('/home/dev/app.ts')
  })

  it('keeps non-WSL paths unchanged', () => {
    expect(resolveTerminalPathForCommand('/home/dev/app.ts', '/home/dev')).toBe('/home/dev/app.ts')
    expect(resolveTerminalPathForCommand('/home/dev/app.ts', undefined)).toBe('/home/dev/app.ts')
  })
})

describe('openCustomEditorTerminalTab', () => {
  beforeEach(() => {
    mockState = createStoreState()
    stubWindowApi(vi.fn())
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('spawns a terminal tab running the command with the quoted path', () => {
    const opened = openCustomEditorTerminalTab({
      command: 'helix',
      filePath: '/repo/my file.ts',
      worktreeId: 'wt-1'
    })

    expect(opened).toBe(true)
    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'helix'
    })
    expect(mockState.queueTabStartupCommand).toHaveBeenCalledWith('tab-new', {
      command: "helix '/repo/my file.ts'"
    })
    expect(mockState.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(mockState.setTabBarOrder).toHaveBeenCalled()
  })

  it('refuses an empty command', () => {
    expect(
      openCustomEditorTerminalTab({
        command: '   ',
        filePath: '/repo/a.ts',
        worktreeId: 'wt-1'
      })
    ).toBe(false)
    expect(mockState.createTab).not.toHaveBeenCalled()
  })

  it('refuses an empty worktree id so no stranded tab is created', () => {
    expect(
      openCustomEditorTerminalTab({
        command: 'helix',
        filePath: '/repo/a.ts',
        worktreeId: ''
      })
    ).toBe(false)
    expect(mockState.createTab).not.toHaveBeenCalled()
  })
})

describe('routeFileOpenToDefaultEditor', () => {
  beforeEach(() => {
    mockState = createStoreState()
    stubWindowApi(vi.fn())
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('keeps builtin mode on the built-in editor', async () => {
    const openFilePath = vi.fn()
    stubWindowApi(openFilePath)
    mockState.settings = { defaultEditorMode: 'builtin' }

    const route = await routeFileOpenToDefaultEditor({
      filePath: '/repo/a.ts',
      worktreeId: 'wt-1'
    })

    expect(route).toBe('builtin')
    expect(openFilePath).not.toHaveBeenCalled()
  })

  it('opens with the system default when the OS handles the path', async () => {
    const openFilePath = vi.fn().mockResolvedValue(true)
    stubWindowApi(openFilePath)
    mockState.settings = { defaultEditorMode: 'system' }

    const route = await routeFileOpenToDefaultEditor({
      filePath: '/repo/a.ts',
      worktreeId: 'wt-1'
    })

    expect(route).toBe('system')
    expect(openFilePath).toHaveBeenCalledWith('/repo/a.ts')
  })

  it('falls back to the built-in editor when the OS cannot open the path', async () => {
    const openFilePath = vi.fn().mockResolvedValue(false)
    stubWindowApi(openFilePath)
    mockState.settings = { defaultEditorMode: 'system' }

    const route = await routeFileOpenToDefaultEditor({
      filePath: '/repo/a.ts',
      worktreeId: 'wt-1'
    })

    expect(route).toBe('builtin')
  })

  it('keeps remote files on the built-in editor', async () => {
    const openFilePath = vi.fn()
    stubWindowApi(openFilePath)
    mockState.settings = { defaultEditorMode: 'system' }

    const route = await routeFileOpenToDefaultEditor({
      filePath: '/repo/a.ts',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'runtime-env-1'
    })

    expect(route).toBe('remote')
    expect(openFilePath).not.toHaveBeenCalled()
  })

  it('routes custom mode to a terminal tab with the command', async () => {
    mockState.settings = {
      defaultEditorMode: 'custom',
      defaultEditorCustomCommand: 'helix'
    }

    const route = await routeFileOpenToDefaultEditor({
      filePath: '/repo/a.ts',
      worktreeId: 'wt-1'
    })

    expect(route).toBe('custom')
    expect(mockState.queueTabStartupCommand).toHaveBeenCalledWith('tab-new', {
      command: 'helix /repo/a.ts'
    })
  })

  it('falls back to the built-in editor when the custom command is empty', async () => {
    mockState.settings = { defaultEditorMode: 'custom', defaultEditorCustomCommand: '' }

    const route = await routeFileOpenToDefaultEditor({
      filePath: '/repo/a.ts',
      worktreeId: 'wt-1'
    })

    expect(route).toBe('builtin')
    expect(mockState.createTab).not.toHaveBeenCalled()
  })

  it('keeps SSH files on the built-in editor', async () => {
    mockState.settings = {
      defaultEditorMode: 'custom',
      defaultEditorCustomCommand: 'helix'
    }

    const route = await routeFileOpenToDefaultEditor({
      filePath: '/repo/a.ts',
      worktreeId: 'wt-1',
      connectionId: 'ssh-1'
    })

    expect(route).toBe('remote')
    expect(mockState.createTab).not.toHaveBeenCalled()
  })
})
