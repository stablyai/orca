// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { stack } = vi.hoisted(() => ({ stack: { show: vi.fn(), hide: vi.fn() } }))
vi.mock('./cloud-toast-stack', () => ({ showCloudToast: stack.show, hideCloudToast: stack.hide }))
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

describe('CloudSetupNoticesDock (DS-o, DS-q)', () => {
  it('is one warning in the shared cloud toast stack, and leaves with its workspace', () => {
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
    const [id, shown] = stack.show.mock.calls.at(-1) ?? []
    expect(id).toBe(cloudSetupToastId('env-1'))
    expect(shown.priority).toBe('warning')
    // "Install on stablyai" stays outline: a way forward, not the required next step.
    expect(shown.lines[0].action).toMatchObject({ label: 'Install on stablyai' })
    expect(shown.lines[0].action.primary).toBeUndefined()
    // Its last line dismissed: the toast goes too.
    dismissCloudSetupNotice('env-1', 'git.push')
    view.rerender(<CloudSetupNoticesDock workspaceId="w1" />)
    expect(stack.hide).toHaveBeenCalledWith(cloudSetupToastId('env-1'))
    stack.hide.mockClear()
    vi.useFakeTimers()
    view.unmount()
    // Applied a tick later, so a StrictMode remount can claim the toast back first.
    expect(stack.hide).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(stack.hide).toHaveBeenCalledWith(cloudSetupToastId('env-1'))
    vi.useRealTimers()
  })
})
