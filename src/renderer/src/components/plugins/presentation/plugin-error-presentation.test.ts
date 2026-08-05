import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { pluginInstallErrorMessage } from './plugin-error-presentation'

describe('pluginInstallErrorMessage', () => {
  it('explains reserved local-path identity blocks for official template forks', () => {
    const message = pluginInstallErrorMessage(
      new Error(
        'reserved plugin identity stablyai.orca-portuguese cannot be installed from a local path. Change publisher and id in orca-plugin.json'
      )
    )
    expect(message.toLowerCase()).toContain('reserved official identity')
    expect(message.toLowerCase()).toContain('orca-plugin.json')
  })

  it('explains reserved git identity blocks', () => {
    const message = pluginInstallErrorMessage(
      new Error(
        'reserved plugin identity community.orca-secrets must resolve to the stablyai organization'
      )
    )
    expect(message.toLowerCase()).toContain('reserved official identity')
    expect(message.toLowerCase()).toContain('stablyai')
  })
})
