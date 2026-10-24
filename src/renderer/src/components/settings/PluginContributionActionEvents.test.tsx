// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { usePluginWorkerEvents } from './PluginContributionActionEvents'

const useInstalledPluginManifest = vi.hoisted(() => vi.fn())
vi.mock('./use-plugin-contribution-source', () => ({ useInstalledPluginManifest }))

const plugin: PluginHostListEntry = {
  pluginKey: 'orca-samples.hello-orca',
  consentFingerprint: 'sha256-hello',
  name: 'Hello Orca',
  version: '1.0.0',
  publisher: 'orca-samples',
  status: 'running',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [],
  hasWorker: true,
  execution: 'trusted-worker',
  restarts: 0,
  source: { kind: 'local-path', reference: '/tmp/hello', resolvedCommit: null, contentHash: 'h' }
}

afterEach(() => useInstalledPluginManifest.mockReset())

it('names each subscribed event once, keyed to the installed revision', () => {
  useInstalledPluginManifest.mockReturnValue({
    contributes: {
      events: [{ on: 'worktree.created' }, { on: 'worktree.created' }, { on: 'worktree.removed' }]
    }
  })
  const { result } = renderHook(() => usePluginWorkerEvents(plugin))
  expect(result.current).toEqual(['worktree.created', 'worktree.removed'])
  expect(useInstalledPluginManifest).toHaveBeenCalledWith('orca-samples.hello-orca', 'sha256-hello')
})

it('never reads a manifest for a plugin without a worker', () => {
  useInstalledPluginManifest.mockReturnValue(undefined)
  const { result } = renderHook(() => usePluginWorkerEvents({ ...plugin, hasWorker: false }))
  expect(result.current).toEqual([])
  expect(useInstalledPluginManifest).toHaveBeenCalledWith(null, 'sha256-hello')
})
