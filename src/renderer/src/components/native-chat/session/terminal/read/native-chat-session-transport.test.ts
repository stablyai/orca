// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const { webClient } = vi.hoisted(() => ({ webClient: { value: false } }))
vi.mock('@/app-shell/platform/web-client-location', () => ({
  isWebClientLocation: () => webClient.value
}))

import { getNativeChatSessionTransport } from './native-chat-session-transport'

describe('getNativeChatSessionTransport', () => {
  afterEach(() => {
    webClient.value = false
  })

  it('pages by cursor only for desktop-local chats', () => {
    expect(getNativeChatSessionTransport(null).pagesByCursor).toBe(true)
    expect(getNativeChatSessionTransport('env-1').pagesByCursor).toBeUndefined()
    webClient.value = true
    expect(getNativeChatSessionTransport(null).pagesByCursor).toBeUndefined()
    expect(getNativeChatSessionTransport('env-1').pagesByCursor).toBeUndefined()
  })
})
