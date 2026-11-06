import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { pluginInstallErrorMessage } from './plugin-error-presentation'

// Why: keep presentation tests locked to pluginInstallTrustError production strings
// so a "git" substring cannot silently re-route reserved errors to installGit.
const reservedRefusal = (pluginKey: string): string =>
  `${pluginKey} uses a name reserved for official Orca plugins; Orca installs it only from its official catalog`

describe('pluginInstallErrorMessage', () => {
  it('explains how to rename a local fork of an official template', () => {
    const message = pluginInstallErrorMessage(
      new Error(reservedRefusal('stablyai.orca-portuguese'))
    )
    expect(message).toContain('reserved for official Orca plugins')
    expect(message).toContain('orca-plugin.json')
    expect(message).toContain('"orca-"')
    expect(message).toContain('"publisher"')
  })

  it('does not mistake a reserved key containing "git" for a fetch failure', () => {
    const message = pluginInstallErrorMessage(new Error(reservedRefusal('github.tools')))
    expect(message).toContain('reserved for official Orca plugins')
    expect(message).not.toContain("Couldn't fetch")
  })

  it('still maps genuine git fetch failures to the installGit message', () => {
    const message = pluginInstallErrorMessage(
      new Error('git fetch failed: could not clone repository from remote')
    )
    expect(message).toContain("Couldn't fetch this Git revision")
  })
})
