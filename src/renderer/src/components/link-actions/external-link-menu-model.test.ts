import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowser } from '../../../../shared/external-browser-types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

type StoreState = {
  settings: { externalBrowserId?: string | null; localhostWorktreeLabelsEnabled?: boolean } | null
  installedBrowsers: InstalledBrowser[] | null
}
const storeState = vi.hoisted((): StoreState => ({ settings: null, installedBrowsers: null }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { buildExternalLinkMenuModel } from './external-link-menu-model'

const BROWSERS: InstalledBrowser[] = [
  { id: 'com.google.Chrome', name: 'Google Chrome' },
  { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' },
  { id: 'com.apple.Safari', name: 'Safari' }
]
const URL_TARGET = {
  url: 'https://github.com/stablyai/orca/pull/1',
  worktreeId: 'wt-1',
  sourceOwner: { kind: 'local' } as const,
  canOpenOwnedBrowser: false
}

const openUrl = vi.fn()
const registerLocalhostLabel = vi.fn()
let workspacePortScansByKey: Record<string, WorkspacePortScanResult> = {}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.settings = null
  storeState.installedBrowsers = BROWSERS
  workspacePortScansByKey = {}
  vi.stubGlobal('window', {
    api: { shell: { openUrl }, localhostWorktreeLabels: { register: registerLocalhostLabel } }
  })
  registerHttpLinkStoreAccessor(() => ({
    settings: storeState.settings,
    setActiveWorktree: vi.fn(),
    createBrowserTab: vi.fn(),
    repos: [{ id: 'repo-1', displayName: 'snapstudio' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-analytics' }] },
    workspacePortScansByKey
  }))
})

describe('buildExternalLinkMenuModel', () => {
  it('offers no Orca row for a runtime link whose owner cannot reach Orca’s browser', () => {
    const model = buildExternalLinkMenuModel(
      {
        ...URL_TARGET,
        sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' },
        canOpenOwnedBrowser: false
      },
      BROWSERS
    )

    expect(model.orcaBrowser).toBeNull()
    expect(model.externalDefault.name).toBe('System Browser')
  })

  it('offers no installed browsers when the client lists none', () => {
    expect(buildExternalLinkMenuModel(URL_TARGET, []).installedBrowsers).toEqual([])
    expect(buildExternalLinkMenuModel(URL_TARGET, null).installedBrowsers).toEqual([])
  })

  it('opens a picked browser for this link only', () => {
    const model = buildExternalLinkMenuModel(URL_TARGET, BROWSERS)

    model.installedBrowsers.find((browser) => browser.name === 'Google Chrome')?.open()

    expect(openUrl).toHaveBeenCalledWith(URL_TARGET.url, 'com.google.Chrome')
  })

  it('opens the worktree-labeled URL of a scanned loopback port in the picked browser', async () => {
    storeState.settings = { localhostWorktreeLabelsEnabled: true }
    workspacePortScansByKey = {
      'local:all': {
        platform: 'darwin',
        scannedAt: 1,
        ports: [
          {
            id: 'tcp:5180',
            kind: 'workspace',
            port: 5180,
            protocol: 'http',
            bindHost: '127.0.0.1',
            connectHost: 'localhost',
            owner: {
              repoId: 'repo-1',
              worktreeId: 'wt-analytics',
              displayName: 'analytics',
              path: '/repo/analytics',
              confidence: 'cwd'
            }
          }
        ]
      }
    }
    registerLocalhostLabel.mockResolvedValue({ url: 'http://analytics.orca.localhost:60016/' })
    const model = buildExternalLinkMenuModel(
      { ...URL_TARGET, url: 'http://localhost:5180/' },
      BROWSERS
    )

    model.installedBrowsers.find((browser) => browser.name === 'Safari')?.open()
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled())

    expect(openUrl).toHaveBeenCalledWith(
      'http://analytics.orca.localhost:60016/',
      'com.apple.Safari'
    )
  })

  it('names the configured browser on the external row and lists every detected browser', () => {
    storeState.settings = { externalBrowserId: 'com.microsoft.edgemac' }

    const model = buildExternalLinkMenuModel(URL_TARGET, BROWSERS)
    model.externalDefault.open()

    expect(model.orcaBrowser?.name).toBe('Orca Browser')
    expect(model.externalDefault.name).toBe('Microsoft Edge')
    expect(model.installedBrowsers.map((browser) => browser.name)).toEqual([
      'Google Chrome',
      'Microsoft Edge',
      'Safari'
    ])
    // The external row follows the default in main rather than naming a browser.
    expect(openUrl).toHaveBeenCalledWith(URL_TARGET.url)
  })
})
