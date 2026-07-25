// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import { SkillFreshnessStatusPill } from './SkillFreshnessStatusPill'
import { consumeSkillFreshnessUpdateDialogRequest } from './skill-freshness-update-dialog'

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

function detailsButton(container: HTMLDivElement): HTMLButtonElement | null {
  return container.querySelector('[data-slot="button"]')
}

function pillText(container: HTMLDivElement): string {
  return (container.textContent ?? '').replace(detailsButton(container)?.textContent ?? '', '')
}

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
    // Why: the dialog request is module-level state shared across tests.
    consumeSkillFreshnessUpdateDialogRequest()
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

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Update available')
    expect(detailsButton(rendered)?.textContent).toBe('Details')
  })

  it('shows Up to date when every placement is current', async () => {
    mocks.inventory = inventory([{ name: 'orca-cli', status: 'current' }], [])

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Up to date')
    // Why: nothing is out of date, so the review dialog would have no row to show.
    expect(detailsButton(rendered)).toBeNull()
  })

  it('flags a blocked outdated placement instead of reading as all-clear', async () => {
    mocks.inventory = inventory(
      [
        { name: 'orca-cli', status: 'outdated' },
        { name: 'orca-cli', status: 'unrecognized' }
      ],
      []
    )

    const rendered = await renderPill('orca-cli')
    // Why: a green pill over a copy the update cannot reach hides real drift.
    expect(pillText(rendered)).toBe('Needs attention')
    expect(detailsButton(rendered)?.textContent).toBe('Details')
  })

  it('falls back to Installed before the inventory loads', async () => {
    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Installed')
    expect(detailsButton(rendered)).toBeNull()
  })

  it('opens the freshness review dialog from Details', async () => {
    mocks.inventory = inventory([{ name: 'orca-cli', status: 'outdated' }], ['orca-cli'])
    const rendered = await renderPill('orca-cli')

    await act(async () => {
      detailsButton(rendered)?.click()
    })

    expect(consumeSkillFreshnessUpdateDialogRequest()).toBe(true)
  })
})
