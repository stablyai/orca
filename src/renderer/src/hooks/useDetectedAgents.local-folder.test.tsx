// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { Repo } from '../../../shared/repo-types'
import type { PreflightRuntimeContext } from '../../../preload/api/preflight-api'
import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'
import { resetLocalPreflightContextCachesForTests } from '@/lib/local-preflight-context'
import { useAgentDetectionTargetForWorktree } from './useAgentDetectionTarget'
import { useDetectedAgents } from './useDetectedAgents'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const INITIAL_STATE = useAppStore.getInitialState()
const ORIGINAL_API = Object.getOwnPropertyDescriptor(window, 'api')
const UBUNTU_KEY = folderWorkspaceKey('ubuntu')
const DEBIAN_KEY = folderWorkspaceKey('debian')
const NATIVE_KEY = folderWorkspaceKey('native')
const detectAgents = vi.fn<(context?: PreflightRuntimeContext) => Promise<string[]>>()
let root: Root | undefined
let container: HTMLDivElement | undefined

function Probe({ workspaceKey }: { workspaceKey: string }): ReactNode {
  const target = useAgentDetectionTargetForWorktree(workspaceKey)
  const result = useDetectedAgents(target)
  return createElement('output', null, JSON.stringify(result.detectedIds))
}

function makeRepo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: 'blue',
    addedAt: 1,
    projectGroupId: 'group',
    executionHostId: 'local'
  }
}

async function render(workspaceKey: string): Promise<void> {
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  const mountedRoot = root
  await act(async () => {
    mountedRoot.render(createElement(Probe, { workspaceKey }))
  })
}

async function warmNativeCache(): Promise<void> {
  await useAppStore.getState().ensureDetectedAgents(NATIVE_KEY)
  expect(useAppStore.getState().detectedAgentIds).toEqual(['codex'])
  detectAgents.mockClear()
}

beforeEach(() => {
  resetRendererAppPlatformCacheForTests()
  resetLocalPreflightContextCachesForTests()
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(INITIAL_STATE, true)
  detectAgents
    .mockReset()
    .mockImplementation(async (context) =>
      context?.wslDistro === 'Ubuntu'
        ? ['claude']
        : context?.wslDistro === 'Debian'
          ? ['opencode']
          : ['codex']
    )
  const platform: Window['api']['platform'] = {
    get: () => ({
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0',
      shell: 'cmd.exe',
      displayServer: null
    })
  }
  const preflight: Pick<Window['api']['preflight'], 'detectAgents'> = { detectAgents }
  Object.defineProperty(window, 'api', { configurable: true, value: { platform, preflight } })
  useAppStore.setState({
    activeRepoId: null,
    activeWorktreeId: UBUNTU_KEY,
    projects: [],
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: {},
    repos: [
      makeRepo('one', '//wsl.localhost/Ubuntu/home/alice/projects/one'),
      makeRepo('two', '//wsl.localhost/Ubuntu/home/alice/projects/two')
    ],
    folderWorkspaces: [
      makeFolderWorkspace({
        id: 'ubuntu',
        projectGroupId: 'group',
        folderPath: '//wsl.localhost/Ubuntu/home/alice/projects',
        executionHostId: 'local'
      }),
      makeFolderWorkspace({
        id: 'debian',
        projectGroupId: 'group',
        folderPath: '//wsl.localhost/Debian/home/alice/projects',
        executionHostId: 'local'
      }),
      makeFolderWorkspace({
        id: 'native',
        projectGroupId: 'group',
        folderPath: 'C:/Users/alice/projects',
        executionHostId: 'local'
      })
    ],
    projectGroups: []
  })
})

afterEach(async () => {
  if (root) {
    const mountedRoot = root
    await act(async () => mountedRoot.unmount())
  }
  container?.remove()
  root = undefined
  container = undefined
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(INITIAL_STATE, true)
  if (ORIGINAL_API) {
    Object.defineProperty(window, 'api', ORIGINAL_API)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('local folder agent picker detection', () => {
  it('probes Ubuntu instead of showing a warmed native Windows list', async () => {
    await warmNativeCache()
    await render(UBUNTU_KEY)

    expect(detectAgents).toHaveBeenCalledWith(expect.objectContaining({ wslDistro: 'Ubuntu' }))
    expect(container?.textContent).toBe('["claude"]')
  })

  it('probes a requested nonactive folder independently of the active folder', async () => {
    await warmNativeCache()
    await render(DEBIAN_KEY)

    expect(detectAgents).toHaveBeenCalledWith(expect.objectContaining({ wslDistro: 'Debian' }))
    expect(container?.textContent).toBe('["opencode"]')
  })

  it('uses separate caches when one mounted picker moves through Ubuntu, Windows and Debian', async () => {
    await warmNativeCache()
    await render(UBUNTU_KEY)
    expect(container?.textContent).toBe('["claude"]')
    await render(NATIVE_KEY)
    expect(container?.textContent).toBe('["codex"]')
    await render(DEBIAN_KEY)
    expect(container?.textContent).toBe('["opencode"]')
    await render(UBUNTU_KEY)
    expect(container?.textContent).toBe('["claude"]')
    expect(detectAgents.mock.calls.map(([context]) => context?.wslDistro)).toEqual([
      'Ubuntu',
      'Debian'
    ])
  })

  it('does not display a late Ubuntu result after the picker switches to native Windows', async () => {
    let resolveUbuntu: ((agents: string[]) => void) | undefined
    const delayedUbuntu = new Promise<string[]>((resolve) => {
      resolveUbuntu = resolve
    })
    detectAgents.mockImplementation((context) =>
      context?.wslDistro === 'Ubuntu' ? delayedUbuntu : Promise.resolve(['codex'])
    )

    await render(UBUNTU_KEY)
    await render(NATIVE_KEY)
    expect(container?.textContent).toBe('["codex"]')
    await act(async () => {
      resolveUbuntu?.(['claude'])
      await delayedUbuntu
    })
    expect(container?.textContent).toBe('["codex"]')
    expect(detectAgents.mock.calls.map(([context]) => context?.wslDistro)).toEqual([
      'Ubuntu',
      undefined
    ])
  })
})
