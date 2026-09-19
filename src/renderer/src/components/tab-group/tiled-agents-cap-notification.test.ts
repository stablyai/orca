import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ toastInfo: vi.fn() }))

vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo } }))
// Why: pins the assertion to this module's fallback text regardless of the real catalog's
// (possibly stale, see 0.8) stored value for this key.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { notifyTiledAgentsPaneCapReached } from './tiled-agents-cap-notification'

describe('notifyTiledAgentsPaneCapReached (finding 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the cap toast once per app session even when reconciled worktrees hit the cap repeatedly', () => {
    notifyTiledAgentsPaneCapReached()
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Showing the first 9 agents as cards',
      expect.objectContaining({ description: 'Additional agents open as ordinary tabs.' })
    )

    // ...then a tenth agent overflowing a second worktree in the same session: no second toast.
    notifyTiledAgentsPaneCapReached()
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })
})
