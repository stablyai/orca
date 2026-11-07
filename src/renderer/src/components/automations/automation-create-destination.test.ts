import { describe, expect, it } from 'vitest'
import { buildAutomationHostCatalog } from './automation-host-catalog'
import type { AutomationCatalogSshMirrorInput } from './automation-host-catalog-types'
import {
  automationCreateHostOffered,
  preselectAutomationCreateHost
} from './automation-create-destination'

function mirror(
  targets: AutomationCatalogSshMirrorInput['targets']
): AutomationCatalogSshMirrorInput {
  return {
    targetsHydrated: true,
    targets,
    removedTargetLabels: new Map(),
    connectionStatusByTargetId: new Map()
  }
}

describe('create destination on a managed SSH host', () => {
  it("lists only the host's server and lands its desktop SSH key there", () => {
    const { entries } = buildAutomationHostCatalog({
      desktop: {
        label: 'Local Mac',
        ssh: mirror([{ targetId: 'box', label: 'Build box', generation: 2 }])
      },
      runtimes: [
        {
          environmentId: 'env-1',
          label: 'Build box',
          pairingRevision: 3,
          authorityHealth: 'fresh',
          querySupport: 'scoped',
          ssh: mirror([]),
          managedSshTargetId: 'box'
        }
      ],
      runtimeCatalogSettled: true
    })
    const desktopSshKey = 'host:desktop:ssh:box'

    const desktopSsh = entries.find((entry) => entry.stableKey === desktopSshKey)
    expect(desktopSsh && automationCreateHostOffered(desktopSsh)).toBe(false)
    expect(preselectAutomationCreateHost(entries, desktopSshKey, null)?.stableKey).toBe(
      'host:runtime:env-1:self'
    )
  })
})
