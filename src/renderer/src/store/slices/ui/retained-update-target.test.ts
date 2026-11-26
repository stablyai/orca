import { expect, it } from 'vitest'
import { reconcileRetainedUpdateTarget } from './retained-update-target'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'

it('keeps restart errors attached only to the retained download attempt', () => {
  const downloaded: UpdateStatus = {
    state: 'downloaded',
    version: '1.4.273',
    installOnQuit: true
  }
  const attempted = reconcileRetainedUpdateTarget(null, downloaded)
  expect(attempted).toEqual({ version: '1.4.273', source: undefined })

  const installing = reconcileRetainedUpdateTarget(attempted, { ...downloaded, installing: true })
  expect(installing).toBe(attempted)
  expect(reconcileRetainedUpdateTarget(installing, { ...downloaded })).toBe(attempted)
  expect(
    reconcileRetainedUpdateTarget(attempted, {
      state: 'error',
      version: '1.4.273',
      retryAction: 'install',
      message: 'The checkpoint could not be saved.'
    })
  ).toBe(attempted)
  expect(reconcileRetainedUpdateTarget(attempted, { ...downloaded, version: '1.4.274' })).not.toBe(
    attempted
  )
  expect(reconcileRetainedUpdateTarget(attempted, { ...downloaded, source: 'local' })).not.toBe(
    attempted
  )

  const redownloading = reconcileRetainedUpdateTarget(attempted, {
    state: 'downloading',
    version: '1.4.273',
    percent: 25
  })
  expect(redownloading).toBeNull()
  expect(reconcileRetainedUpdateTarget(redownloading, downloaded)).not.toBe(attempted)
})
