// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { SkillFreshnessStatusPill } from './SkillFreshnessStatusPill'
import { consumeSkillFreshnessUpdateDialogRequest } from './skill-freshness-update-dialog'
import { planEntry, planOf, planOp, sharedEntry } from './bundled-skill-plan-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  plan: ((): BundledSkillPlan | null => null)(),
  loading: false,
  error: null as string | null
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    plan: mocks.plan,
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
    mocks.plan = null
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

  it('shows Update available when the plan updates the skill', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Update available')
    expect(detailsButton(rendered)?.textContent).toBe('Details')
  })

  it('shows Up to date when every location is current', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'keep')])

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Up to date')
    expect(detailsButton(rendered)).toBeNull()
  })

  it('offers Details beside Installed when an agent still needs linking', async () => {
    mocks.plan = planOf([
      planEntry('orca-cli', [
        planOp('keep', '/home/u/.agents/skills/orca-cli'),
        planOp('link', '/home/u/.claude/skills/orca-cli')
      ])
    ])

    const rendered = await renderPill('orca-cli')
    expect(pillText(rendered)).toBe('Installed')
    expect(detailsButton(rendered)?.textContent).toBe('Details')
  })

  it('flags a copy the update leaves alone instead of reading as all-clear', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'leave', { reason: 'edited' })])

    const rendered = await renderPill('orca-cli')
    // Why: a green pill over a copy the update cannot reach hides real drift.
    expect(pillText(rendered)).toBe('Review skill')
    expect(detailsButton(rendered)?.textContent).toBe('Details')
  })

  it('falls back to Installed before the plan loads', async () => {
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
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    const rendered = await renderPill('orca-cli')

    await act(async () => {
      detailsButton(rendered)?.click()
    })

    expect(consumeSkillFreshnessUpdateDialogRequest()).toBe(true)
  })
})
