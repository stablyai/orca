// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeDownloadProgressEvent } from '../../../../../../shared/runtime-downloads/runtime-download-contract'
import type { TreeNode } from '../tree/file-explorer-types'
import {
  applyRuntimeDownloadProgress,
  getRuntimeDownloadProgress,
  subscribeRuntimeDownloadProgress,
  trackRuntimeDownload
} from '@/runtime/files/downloads/runtime-download-progress-store'
import {
  shouldShowOpenLocallyAction,
  shouldShowRemoteDownloadAction
} from './file-explorer-row-action-visibility'

vi.mock('@/lib/cloud-remote-desktop/cloud-environment-ids', () => ({
  isKnownCloudEnvironment: (id: string) => id === 'cloud-env',
  refreshCloudEnvironmentIds: async () => {}
}))

const { outcomeState } = await import('./runtime-download-actions')

function node(name: string, isDirectory = false): TreeNode {
  return { name, path: `/w/${name}`, relativePath: name, isDirectory, depth: 0 }
}

const base = { itemKind: 'file' as const, environmentId: 'cloud-env', elapsedMs: 1_000 }

describe('outcomeState', () => {
  it('leaves nothing behind for a canceled download or a file that opened', () => {
    expect(outcomeState({ status: 'canceled' }, { ...base, node: node('a'), intent: 'save' })).toBe(
      null
    )
    expect(
      outcomeState(
        { status: 'done', destinationPath: '/tmp/a', bytes: 1 },
        { ...base, node: node('a'), intent: 'open' }
      )
    ).toBe(null)
  })

  it('reports a saved copy no app could open as a soft no-app state', () => {
    expect(
      outcomeState(
        { status: 'done', destinationPath: '/tmp/a.xyz', bytes: 1, openError: 'no app' },
        { ...base, node: node('a.xyz'), intent: 'open' }
      )
    ).toEqual({ kind: 'no_app', name: 'a.xyz' })
  })

  it('names the sandbox only for cloud workspaces', () => {
    const error = { status: 'error', code: 'not_found', message: 'x' } as const
    expect(outcomeState(error, { ...base, node: node('a'), intent: 'save' })).toMatchObject({
      kind: 'failed',
      place: 'sandbox'
    })
    expect(
      outcomeState(error, { ...base, environmentId: 'ssh-box', node: node('a'), intent: 'save' })
    ).toMatchObject({ kind: 'failed', place: 'host' })
  })

  it('never offers Open on the done card for files the OS would run', () => {
    vi.stubGlobal('api', { platform: { get: () => ({ platform: 'darwin' }) } })
    const done = { status: 'done', destinationPath: '/d/x', bytes: 3 } as const
    expect(outcomeState(done, { ...base, node: node('setup.sh'), intent: 'save' })).toMatchObject({
      kind: 'done',
      canOpen: false
    })
    expect(outcomeState(done, { ...base, node: node('report.pdf'), intent: 'save' })).toMatchObject(
      { kind: 'done', canOpen: true }
    )
  })
})

describe('row action visibility', () => {
  it('offers folder downloads on runtime hosts without an SSH connection', () => {
    expect(shouldShowRemoteDownloadAction(node('src', true), null, null, false, true)).toBe(true)
    expect(shouldShowRemoteDownloadAction(node('src', true), null, null, false, false)).toBe(false)
  })

  it('hides Open on This Computer for folders, SSH and runnable files', () => {
    expect(shouldShowOpenLocallyAction(node('a.pdf'), null, true)).toBe(true)
    expect(shouldShowOpenLocallyAction(node('src', true), null, true)).toBe(false)
    expect(shouldShowOpenLocallyAction(node('a.pdf'), 'ssh-1', true)).toBe(false)
    for (const name of ['run.sh', 'Setup.EXE', 'x.command', 'evil.bat. ']) {
      expect(shouldShowOpenLocallyAction(node(name), null, true)).toBe(false)
    }
  })
})

describe('runtime download progress store', () => {
  const unsubscribe = vi.fn()
  afterEach(() => {
    unsubscribe.mockReset()
  })

  function event(receivedBytes: number): RuntimeDownloadProgressEvent {
    return {
      downloadId: 'd1',
      phase: 'transferring',
      receivedBytes,
      totalBytes: 100,
      processedBytes: receivedBytes
    }
  }

  it('smooths the rate, tracks its window and drops the IPC listener on release', () => {
    const onProgress = vi.fn(() => unsubscribe)
    vi.stubGlobal('api', { runtimeDownloads: { onProgress } })
    const release = trackRuntimeDownload('d1')
    expect(onProgress).toHaveBeenCalledOnce()
    applyRuntimeDownloadProgress(event(0), 0)
    applyRuntimeDownloadProgress(event(10), 1_000)
    applyRuntimeDownloadProgress(event(30), 2_000)
    const snapshot = getRuntimeDownloadProgress('d1')
    // 10 B/s, then 20 B/s smoothed by 0.3.
    expect(snapshot?.bytesPerSecond).toBeCloseTo(13)
    expect(snapshot?.rateWindowMs).toBe(2_000)
    release()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(getRuntimeDownloadProgress('d1')).toBe(null)
  })

  it('does not bring back a released download when a late toast subscribes', () => {
    const onProgress = vi.fn(() => unsubscribe)
    vi.stubGlobal('api', { runtimeDownloads: { onProgress } })
    const release = trackRuntimeDownload('d2')
    release()
    subscribeRuntimeDownloadProgress('d2', () => {})()
    // A new download must start a fresh IPC listener: the old entry did not linger.
    trackRuntimeDownload('d3')()
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })
})
