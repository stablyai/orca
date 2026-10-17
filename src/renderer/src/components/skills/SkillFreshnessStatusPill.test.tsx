// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import {
  agentLocation,
  currentPlan,
  freshnessInventory,
  sharedLocation,
  skillPlan,
  updatablePlan
} from '@/lib/bundled-skill-plan-fixtures'
import { SkillFreshnessStatusPill } from './SkillFreshnessStatusPill'
import { consumeSkillFreshnessUpdateDialogRequest } from './skill-freshness-update-dialog'

const mocks = vi.hoisted(() => ({
  inventory: null as SkillFreshnessInventory | null,
  loading: false,
  error: null as string | null
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    inventory: mocks.inventory,
    loading: mocks.loading,
    error: mocks.error,
    refresh: vi.fn()
  })
}))

function detailsButton(container: HTMLDivElement): HTMLButtonElement | null {
  return container.querySelector('[data-slot="button"]')
}

function pillText(container: HTMLDivElement): string {
  return (container.textContent ?? '').replace(detailsButton(container)?.textContent ?? '', '')
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
    mocks.loading = false
    mocks.error = null
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
    mocks.inventory = freshnessInventory(updatablePlan('orca-cli'))

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Update available')
    expect(detailsButton(rendered)?.textContent).toBe('Details')
  })

  it('shows Up to date when every placement is current', async () => {
    mocks.inventory = freshnessInventory(currentPlan('orca-cli'))

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Up to date')
    // Why: nothing is out of date, so the review dialog would have no row to show.
    expect(detailsButton(rendered)).toBeNull()
  })

  it('flags a copy the install leaves instead of reading as all-clear', async () => {
    mocks.inventory = freshnessInventory(
      skillPlan('orca-cli', [
        sharedLocation('orca-cli', 'keep'),
        agentLocation('orca-cli', 'leave', 'unreadable')
      ])
    )

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Review skill')
    expect(detailsButton(rendered)?.textContent).toBe('Details')
  })

  it('falls back to Installed before the inventory loads', async () => {
    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Installed')
    expect(detailsButton(rendered)).toBeNull()
  })

  it('shows a neutral verdict while freshness is being checked', async () => {
    mocks.loading = true

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Checking...')
    expect(detailsButton(rendered)).toBeNull()
  })

  it('does not report success after a freshness check fails', async () => {
    mocks.error = 'Could not read skills.'

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Check failed')
    expect(detailsButton(rendered)).toBeNull()
  })

  it('opens the freshness review dialog from Details', async () => {
    mocks.inventory = freshnessInventory(updatablePlan('orca-cli'))
    const rendered = await renderPill('orca-cli')

    await act(async () => {
      detailsButton(rendered)?.click()
    })

    expect(consumeSkillFreshnessUpdateDialogRequest()).toBe(true)
  })
})
