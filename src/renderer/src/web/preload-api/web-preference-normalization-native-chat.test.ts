import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { mergeSettings } from './web-preference-normalization'

describe('web native chat send shortcut settings', () => {
  it('persists the supported modifier shortcut in the local settings merge', () => {
    const settings = mergeSettings(getDefaultSettings('/tmp'), {
      nativeChatSendShortcut: 'cmd-or-ctrl-enter'
    })

    expect(settings.nativeChatSendShortcut).toBe('cmd-or-ctrl-enter')
  })

  it('normalizes malformed local settings to the backward-compatible default', () => {
    const settings = mergeSettings(
      getDefaultSettings('/tmp'),
      JSON.parse('{"nativeChatSendShortcut":"bad-value"}')
    )

    expect(settings.nativeChatSendShortcut).toBe('enter')
  })
})
