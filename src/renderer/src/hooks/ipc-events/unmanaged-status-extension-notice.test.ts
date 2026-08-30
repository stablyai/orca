import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  notifyUnmanagedStatusExtension,
  resetUnmanagedStatusExtensionNotices
} from './unmanaged-status-extension-notice'

vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))

beforeEach(() => {
  resetUnmanagedStatusExtensionNotices()
  vi.mocked(toast.warning).mockClear()
})

afterEach(() => {
  resetUnmanagedStatusExtensionNotices()
})

describe('unmanaged status extension notice', () => {
  it('raises one toast however many panes the main side reports', () => {
    // Why this lives here and not in the fence: the main side reports per pane *and* source, so
    // a user with 13 affected panes gets 13 detections. Collapsing them is this module's job.
    for (let pane = 0; pane < 13; pane += 1) {
      notifyUnmanagedStatusExtension('omp')
    }
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('still warns once per agent, because the file lives in that agent’s own folder', () => {
    notifyUnmanagedStatusExtension('omp')
    notifyUnmanagedStatusExtension('pi')
    notifyUnmanagedStatusExtension('omp')
    expect(toast.warning).toHaveBeenCalledTimes(2)
    expect(vi.mocked(toast.warning).mock.calls.map((call) => call[1]?.id)).toEqual([
      'unmanaged-status-extension-omp',
      'unmanaged-status-extension-pi'
    ])
  })

  it('ignores an empty source rather than warning about an unnamed agent', () => {
    notifyUnmanagedStatusExtension('')
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
