import { describe, expect, it } from 'vitest'
import { orcaCloudAgentAccountsParts } from './settings-orca-cloud-agent-accounts-sections'
import type { SettingsRenderContext } from './settings-render-context'

function context(model: { showDesktopOnlySettings: boolean; orcaCloudApiAvailable: boolean }) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parts read only model.showDesktopOnlySettings and model.orcaCloudApiAvailable.
  return { model } as unknown as SettingsRenderContext
}

describe('Agent accounts: Orca Cloud parts', () => {
  it('puts Orca Cloud above Hosts, after This computer (JA-04, option A1)', () => {
    const parts = orcaCloudAgentAccountsParts(
      context({ showDesktopOnlySettings: true, orcaCloudApiAvailable: true })
    )
    expect(parts.map((part) => part.id)).toEqual(['accounts-orca-cloud', 'accounts-hosts'])
  })

  it('adds nothing without an Orca Cloud control plane or outside the desktop', () => {
    expect(
      orcaCloudAgentAccountsParts(
        context({ showDesktopOnlySettings: true, orcaCloudApiAvailable: false })
      )
    ).toEqual([])
    expect(
      orcaCloudAgentAccountsParts(
        context({ showDesktopOnlySettings: false, orcaCloudApiAvailable: true })
      )
    ).toEqual([])
  })
})
