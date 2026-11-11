// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { toast } = vi.hoisted(() => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ ephemeralVmRuntimesByWorkspaceId: { w1: { runtimeEnvironmentId: 'env-1' } } })
}))

import { CloudSetupNoticesDock, cloudSetupToastId } from './CloudSetupNotices'
import {
  dismissCloudSetupNotice,
  resetCloudSetupNotices,
  setCloudSetupNotices
} from '@/lib/orca-cloud/cloud-setup-notices-store'

afterEach(() => {
  cleanup()
  resetCloudSetupNotices()
  vi.clearAllMocks()
})

describe('CloudSetupNoticesDock (DS-o)', () => {
  it('joins the app toast stack under one id and leaves it with its workspace', () => {
    setCloudSetupNotices({
      environmentId: 'env-1',
      path: '/w',
      repoId: 'r',
      hostId: null,
      repoUrl: 'https://github.com/stablyai/orca',
      notices: [
        {
          id: 'git.push',
          kind: 'push',
          check: { id: 'git.push', category: 'git', status: 'fail', message: 'refused' }
        }
      ]
    })
    const view = render(<CloudSetupNoticesDock workspaceId="w1" />)
    expect(toast.custom).toHaveBeenCalled()
    expect(toast.custom.mock.calls.at(-1)?.[1]).toMatchObject({
      id: cloudSetupToastId('env-1'),
      duration: Infinity
    })
    // Its last line dismissed: the toast goes too.
    dismissCloudSetupNotice('env-1', 'git.push')
    view.rerender(<CloudSetupNoticesDock workspaceId="w1" />)
    expect(toast.dismiss).toHaveBeenCalledWith(cloudSetupToastId('env-1'))
    toast.dismiss.mockClear()
    view.unmount()
    expect(toast.dismiss).toHaveBeenCalledWith(cloudSetupToastId('env-1'))
  })
})
