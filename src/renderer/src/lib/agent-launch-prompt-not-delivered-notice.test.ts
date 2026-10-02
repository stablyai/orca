import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ message: vi.fn(), track: vi.fn() }))

vi.mock('sonner', () => ({ toast: { message: mocks.message } }))
vi.mock('@/lib/telemetry', () => ({
  track: mocks.track,
  tuiAgentToAgentKind: (agent: string) => agent
}))

import { showAgentLaunchPromptNotDeliveredNotice } from './agent-launch-prompt-not-delivered-notice'

describe('showAgentLaunchPromptNotDeliveredNotice', () => {
  beforeEach(() => {
    mocks.message.mockReset()
  })

  it('stays up until dismissed, since its Copy prompt action is the only copy of the prompt', () => {
    showAgentLaunchPromptNotDeliveredNotice({ agent: 'claude', prompt: 'fix the hook' })

    const options = mocks.message.mock.calls[0]?.[1]
    expect(options?.duration).toBe(Infinity)
    expect(options?.action?.label).toBe('Copy prompt')
  })
})
