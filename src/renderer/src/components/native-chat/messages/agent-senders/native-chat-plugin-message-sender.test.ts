import { describe, expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../../../../shared/plugins/plugin-list-entry'
import { pluginMessageSender } from './native-chat-plugin-message-sender'

const ICON = 'orca-plugin-image://installed/acme.inbox/dev/icon'

function installed(status: PluginHostListEntry['status']): PluginHostListEntry {
  return {
    pluginKey: 'acme.inbox',
    consentFingerprint: null,
    name: 'Acme Inbox',
    version: '1.0.0',
    publisher: 'acme',
    images: { icon: { url: ICON, alt: 'Acme Inbox' } },
    status,
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: true,
    restarts: 0
  }
}

describe('pluginMessageSender', () => {
  it("shows a plugin: sender under the enabled plugin's name and icon", () => {
    expect(pluginMessageSender([installed('idle')], 'plugin:acme.inbox')).toEqual({
      name: 'Acme Inbox',
      iconUrl: ICON
    })
  })

  it('keeps the name and icon of a plugin whose worker errored', () => {
    expect(pluginMessageSender([installed('errored')], 'plugin:acme.inbox')).toEqual({
      name: 'Acme Inbox',
      iconUrl: ICON
    })
  })

  it('leaves a disabled or pending plugin and a bare handle unnamed', () => {
    expect(pluginMessageSender([installed('disabled')], 'plugin:acme.inbox')).toBeUndefined()
    expect(pluginMessageSender([installed('pending')], 'plugin:acme.inbox')).toBeUndefined()
    expect(pluginMessageSender([installed('running')], 'acme.inbox')).toBeUndefined()
  })
})
