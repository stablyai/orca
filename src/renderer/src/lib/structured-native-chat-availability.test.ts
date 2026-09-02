import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { canUseStructuredNativeChat } from './structured-native-chat-availability'

const { mockGetRendererAppPlatform } = vi.hoisted(() => ({
  mockGetRendererAppPlatform: vi.fn<() => NodeJS.Platform>(() => 'darwin')
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: mockGetRendererAppPlatform
}))

type GetLocalProjectExecutionRuntimeContext =
  typeof localPreflightContext.getLocalProjectExecutionRuntimeContext

const projectRuntimeMock = vi.hoisted(() => ({
  fn: vi.fn<GetLocalProjectExecutionRuntimeContext>(),
  actual: undefined as GetLocalProjectExecutionRuntimeContext | undefined
}))

vi.mock('@/lib/local-preflight-context', async (importOriginal) => {
  const actual = await importOriginal<typeof localPreflightContext>()
  projectRuntimeMock.actual = actual.getLocalProjectExecutionRuntimeContext
  return { ...actual, getLocalProjectExecutionRuntimeContext: projectRuntimeMock.fn }
})

const wslRuntimeResolution: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1|wsl|Ubuntu'
  }
}

const repairRequiredResolution: ProjectExecutionRuntimeResolution = {
  status: 'repair-required',
  repair: {
    projectId: 'repo-1',
    preferredRuntime: { kind: 'wsl', distro: null },
    reason: 'wsl-distro-required',
    source: 'project-override',
    cacheKey: 'repo-1|wsl|repair'
  }
}

function stateFor(input: {
  connectionId?: string | null
  windowsRuntime?: 'windows-host' | 'wsl'
  worktreePath?: string
}): AppState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    projects: [
      {
        id: 'repo-1',
        localWindowsRuntimePreference:
          input.windowsRuntime === 'wsl'
            ? { kind: 'wsl', distro: 'Ubuntu' }
            : { kind: 'windows-host' }
      }
    ],
    repos: [{ id: 'repo-1', connectionId: input.connectionId ?? null, path: 'C:\\repo' }],
    settings: { experimentalStructuredNativeChat: true, openAgentTabsInChatByDefault: true },
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          projectId: 'repo-1',
          path: input.worktreePath ?? 'C:\\repo\\worktree'
        }
      ]
    },
    detectedWorktreesByRepo: {}
  } as unknown as AppState
}

describe('canUseStructuredNativeChat', () => {
  beforeEach(() => {
    mockGetRendererAppPlatform.mockReturnValue('darwin')
    projectRuntimeMock.fn.mockReset()
    projectRuntimeMock.fn.mockImplementation((...args) => {
      if (!projectRuntimeMock.actual) {
        throw new Error('real getLocalProjectExecutionRuntimeContext was never captured')
      }
      return projectRuntimeMock.actual(...args)
    })
  })

  it('allows the structured stack on a local worktree', () => {
    expect(canUseStructuredNativeChat(stateFor({}), 'wt-1')).toBe(true)
  })

  it('keeps the legacy bridge when the updated runtime is opted out', () => {
    expect(
      canUseStructuredNativeChat(
        {
          ...stateFor({}),
          settings: {
            experimentalStructuredNativeChat: false,
            openAgentTabsInChatByDefault: true
          }
        } as AppState,
        'wt-1'
      )
    ).toBe(false)
  })

  it('refuses a stale structured opt-in while the default view is Terminal chat', () => {
    expect(
      canUseStructuredNativeChat(
        {
          ...stateFor({}),
          settings: {
            experimentalStructuredNativeChat: true,
            openAgentTabsInChatByDefault: false
          }
        } as AppState,
        'wt-1'
      )
    ).toBe(false)
  })

  it('refuses a structured opt-in when the default view was never chosen', () => {
    expect(
      canUseStructuredNativeChat(
        { ...stateFor({}), settings: { experimentalStructuredNativeChat: true } } as AppState,
        'wt-1'
      )
    ).toBe(false)
  })

  it('refuses an SSH worktree so the pane stays on the bridge', () => {
    expect(canUseStructuredNativeChat(stateFor({ connectionId: 'ssh-a' }), 'wt-1')).toBe(false)
  })

  it('refuses a runtime-paired worktree so the pane stays on the bridge', () => {
    expect(canUseStructuredNativeChat(stateFor({ connectionId: 'runtime-ssh-a' }), 'wt-1')).toBe(
      false
    )
  })

  it('refuses a WSL project on Windows so the pane stays on the bridge', () => {
    mockGetRendererAppPlatform.mockReturnValue('win32')
    expect(canUseStructuredNativeChat(stateFor({ windowsRuntime: 'wsl' }), 'wt-1')).toBe(false)
  })

  it('keeps Windows-host projects on the terminal path until native start-time proof is advertised', () => {
    mockGetRendererAppPlatform.mockReturnValue('win32')
    expect(canUseStructuredNativeChat(stateFor({ windowsRuntime: 'windows-host' }), 'wt-1')).toBe(
      false
    )
  })

  it('refuses a Windows folder workspace even though its key resolves no project runtime', () => {
    mockGetRendererAppPlatform.mockReturnValue('win32')
    const state = {
      ...stateFor({}),
      activeRepoId: null,
      activeWorktreeId: null
    } as unknown as AppState
    expect(canUseStructuredNativeChat(state, 'folder:folder-1')).toBe(false)
  })

  it('allows a folder workspace on a non-Windows platform', () => {
    const state = {
      ...stateFor({}),
      activeRepoId: null,
      activeWorktreeId: null
    } as unknown as AppState
    expect(canUseStructuredNativeChat(state, 'folder:folder-1')).toBe(true)
  })

  it.each(['darwin', 'linux'] as const)('allows a supported local worktree on %s', (platform) => {
    mockGetRendererAppPlatform.mockReturnValue(platform)
    expect(canUseStructuredNativeChat(stateFor({}), 'wt-1')).toBe(true)
  })

  it.each(['darwin', 'linux'] as const)(
    'refuses a WSL project runtime even when the renderer reports %s',
    (platform) => {
      mockGetRendererAppPlatform.mockReturnValue(platform)
      projectRuntimeMock.fn.mockReturnValue(wslRuntimeResolution)
      expect(canUseStructuredNativeChat(stateFor({}), 'wt-1')).toBe(false)
    }
  )

  it.each(['darwin', 'linux'] as const)(
    'refuses a repair-required runtime even when the renderer reports %s',
    (platform) => {
      mockGetRendererAppPlatform.mockReturnValue(platform)
      projectRuntimeMock.fn.mockReturnValue(repairRequiredResolution)
      expect(canUseStructuredNativeChat(stateFor({}), 'wt-1')).toBe(false)
    }
  )
})
