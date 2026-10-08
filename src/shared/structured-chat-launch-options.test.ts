import { describe, expect, it } from 'vitest'
import {
  normalizeStructuredChatLaunchOptions,
  resolveStructuredChatLaunchOptions
} from './structured-chat-launch-options'

describe('new chat permission support', () => {
  it.each([true, false])('keeps the saved Fast choice %s', (fastMode) => {
    expect(
      resolveStructuredChatLaunchOptions(
        {
          nativeChatPermissionMode: 'ask',
          nativeChatSessionOptions: {
            claude: { model: 'sonnet', valuesByModel: { sonnet: { effort: 'high', fastMode } } }
          }
        },
        'claude'
      )
    ).toEqual({
      model: 'sonnet',
      effort: 'high',
      fastMode: String(fastMode),
      permissionMode: 'ask'
    })
  })

  it.each(['true', 'false'])('keeps the encoded Fast choice %s', (fastMode) => {
    const options = { model: 'sonnet', fastMode, permissionMode: 'ask' }
    expect(normalizeStructuredChatLaunchOptions('claude', options)).toEqual(options)
  })

  it('retains reviewer intent for host confirmation and narrows provider-incompatible choices', () => {
    expect(
      resolveStructuredChatLaunchOptions({ nativeChatPermissionMode: 'auto' }, 'claude')
    ).toEqual({ permissionMode: 'auto' })
    expect(
      resolveStructuredChatLaunchOptions({ nativeChatPermissionMode: 'accept-edits' }, 'codex')
    ).toEqual({ permissionMode: 'ask' })
    expect(normalizeStructuredChatLaunchOptions('pi', { permissionMode: 'bypass' })).toEqual({})
  })
})
