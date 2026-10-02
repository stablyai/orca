import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ message: vi.fn(), track: vi.fn() }))

vi.mock('sonner', () => ({ toast: { message: mocks.message } }))
vi.mock('@/lib/telemetry', () => ({
  track: mocks.track,
  tuiAgentToAgentKind: (agent: string) => agent
}))

import {
  showAgentLaunchNotStartedNotice,
  showAgentLaunchPromptNotDeliveredNotice
} from './agent-launch-prompt-not-delivered-notice'

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

  it('tells a user whose agent never started that it did not, with the prompt to copy', async () => {
    const writeClipboardText = vi.fn(async () => {})
    vi.stubGlobal('window', { api: { ui: { writeClipboardText } } })
    showAgentLaunchNotStartedNotice({ prompt: 'fix the hook' })

    const [message, options] = mocks.message.mock.calls[0] ?? []
    expect(message).toMatch(/wasn't started/)
    expect(options?.duration).toBe(Infinity)
    options?.action?.onClick()
    expect(writeClipboardText).toHaveBeenCalledWith('fix the hook')
    vi.unstubAllGlobals()
  })
})
