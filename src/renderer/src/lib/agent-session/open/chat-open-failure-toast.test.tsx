import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { showChatOpenUnavailable } from './chat-open-failure-toast'

describe('showChatOpenUnavailable', () => {
  beforeEach(() => {
    toast.info.mockReset()
    toast.error.mockReset()
  })

  it('says the chat is still starting while its agent resumes, with no retry or details', () => {
    const retry = vi.fn()
    showChatOpenUnavailable({ starting: true, detail: 'timeout', retry }, 'Builder')

    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'This chat is still starting. Try again in a moment.',
      expect.objectContaining({ description: undefined, action: undefined })
    )
  })

  it("says Couldn't open this chat with Retry and the agent-led details otherwise", () => {
    const retry = vi.fn()
    showChatOpenUnavailable({ detail: 'unreachable · timeout', retry }, 'Builder')

    expect(toast.info).not.toHaveBeenCalled()
    const [title, options] = toast.error.mock.calls[0]
    expect(title).toBe("Couldn't open this chat.")
    expect(options.description.props.detail).toBe('Builder\nunreachable · timeout')
    expect(options.action.label).toBe('Retry')
    options.action.onClick()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('shows no details or Retry when the open has neither', () => {
    showChatOpenUnavailable()

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't open this chat.",
      expect.objectContaining({ description: undefined, action: undefined })
    )
  })

  it('reuses one toast so repeated clicks replace it', () => {
    showChatOpenUnavailable({ starting: true })
    showChatOpenUnavailable({ detail: 'x' })

    expect(toast.info.mock.calls[0][1].id).toBe(toast.error.mock.calls[0][1].id)
  })
})
