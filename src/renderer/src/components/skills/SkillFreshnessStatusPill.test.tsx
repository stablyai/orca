// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import { SkillFreshnessStatusPill } from './SkillFreshnessStatusPill'

const mocks = vi.hoisted(() => ({
  inventory: null as SkillFreshnessInventory | null
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    inventory: mocks.inventory,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

function inventory(
  entries: { name: string; status: 'current' | 'outdated' | 'unrecognized' }[],
  eligibleUpdateNames: string[]
): SkillFreshnessInventory {
  return {
    schemaVersion: 1,
    installations: entries.map((entry, index) => ({
      id: `${entry.name}-${index}`,
      name: entry.name,
      rootId: 'home-agents',
      providers: ['agent-skills'],
      sourceKind: 'home',
      sourceLabel: 'Agent skills home',
      unresolvedPath: `/home/.agents/skills/${entry.name}`,
      resolvedPath: `/home/.agents/skills/${entry.name}`,
      physicalIdentity: `physical-${entry.name}-${index}`,
      topology: 'canonical-copy',
      status: entry.status,
      installedReleaseRevision: 1,
      installedAppVersion: '1.0.0',
      currentReleaseRevision: 2,
      currentPackageDigest: 'current',
      currentAppVersion: '2.0.0',
      observedPackageDigest: 'old',
      errorCategory: null
    })),
    eligibleUpdateNames,
    scannedAt: 1
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderPill(skillName: string): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<SkillFreshnessStatusPill skillName={skillName} />)
  })
  return container
}

describe('SkillFreshnessStatusPill', () => {
  beforeEach(() => {
    mocks.inventory = null
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
  })

  it('shows Update available for an eligible outdated skill', async () => {
    mocks.inventory = inventory([{ name: 'orca-cli', status: 'outdated' }], ['orca-cli'])

    expect((await renderPill('orca-cli')).textContent).toBe('Update available')
  })

  it('shows Up to date when every placement is current', async () => {
    mocks.inventory = inventory([{ name: 'orca-cli', status: 'current' }], [])

    expect((await renderPill('orca-cli')).textContent).toBe('Up to date')
  })

  it('falls back to Installed for a blocked outdated placement', async () => {
    mocks.inventory = inventory(
      [
        { name: 'orca-cli', status: 'outdated' },
        { name: 'orca-cli', status: 'unrecognized' }
      ],
      []
    )

    expect((await renderPill('orca-cli')).textContent).toBe('Installed')
  })

  it('falls back to Installed before the inventory loads', async () => {
    expect((await renderPill('orca-cli')).textContent).toBe('Installed')
  })
})
