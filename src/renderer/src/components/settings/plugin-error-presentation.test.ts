import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { pluginInstallErrorMessage } from './plugin-error-presentation'

// Why: keep presentation tests locked to pluginInstallTrustError production strings
// so a "github" substring cannot silently re-route reserved errors to installGit.

const PRODUCTION_RESERVED_LOCAL =
  'reserved plugin identity stablyai.orca-skills cannot be installed from a local path. ' +
  'Forked official templates still use publisher "stablyai" and/or an id starting with "orca-". ' +
  'Change publisher and id in orca-plugin.json to your own identity before local testing.'

const PRODUCTION_RESERVED_GIT =
  'reserved plugin identity community.orca-secrets must resolve to the stablyai organization. ' +
  'Forks must either publish from github.com/stablyai/... or rename publisher/id away from the reserved namespace.'

describe('pluginInstallErrorMessage', () => {
  it('explains reserved local-path identity blocks for official template forks', () => {
    const message = pluginInstallErrorMessage(new Error(PRODUCTION_RESERVED_LOCAL))
    expect(message.toLowerCase()).toContain('reserved official identity')
    expect(message.toLowerCase()).toContain('orca-plugin.json')
    expect(message.toLowerCase()).toContain('change publisher and id')
    expect(message.toLowerCase()).not.toContain('could not fetch')
  })

  it('explains reserved git identity blocks even when the message mentions github.com', () => {
    const message = pluginInstallErrorMessage(new Error(PRODUCTION_RESERVED_GIT))
    expect(message.toLowerCase()).toContain('reserved official identity')
    expect(message.toLowerCase()).toContain('stablyai')
    expect(message.toLowerCase()).toContain('github.com/stablyai')
    expect(message.toLowerCase()).not.toContain('could not fetch')
  })

  it('still maps genuine git fetch failures to the installGit message', () => {
    const message = pluginInstallErrorMessage(
      new Error('git fetch failed: could not clone repository from remote')
    )
    expect(message.toLowerCase()).toContain('could not fetch the pinned git revision')
  })
})
