import { afterEach, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../../shared/update-status-types'
import { downloadAppUpdate } from './app-update-preparation'

afterEach(() => vi.unstubAllGlobals())

it('resolves the saved build before downloading from a restarted idle updater', async () => {
  let status: UpdateStatus = { state: 'idle' }
  const events: string[] = []
  const check = vi.fn(async () => {
    events.push('check')
    status = { state: 'available', version: '1.6.0', changelog: null }
  })
  const download = vi.fn(async () => {
    events.push('download')
    status = { state: 'downloaded', version: '1.6.0' }
  })
  vi.stubGlobal('window', {
    api: {
      updater: {
        listBuilds: async () => ({
          ok: true,
          builds: [{ version: '1.6.0', tag: 'v1.6.0', channel: 'stable' }]
        }),
        check,
        download
      }
    }
  })
  await downloadAppUpdate('1.6.0', () => status, { wait: async () => undefined })
  expect(events).toEqual(['check', 'download'])
  expect(check).toHaveBeenCalledWith({ channel: 'stable', targetTag: 'v1.6.0' })
})

it('refuses a different offered release when the saved local build is gone', async () => {
  const download = vi.fn()
  vi.stubGlobal('window', {
    api: {
      updater: {
        download,
        listBuilds: async () => ({
          ok: true,
          builds: [{ version: '1.7.0', tag: 'v1.7.0', channel: 'stable' }]
        })
      }
    }
  })
  await expect(
    downloadAppUpdate('1.6.0', () => ({ state: 'idle' }), { wait: async () => undefined })
  ).rejects.toThrow('no longer available')
  expect(download).not.toHaveBeenCalled()
})
