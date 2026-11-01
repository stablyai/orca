// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { _skillFreshnessCacheForTests } from '@/hooks/useSkillFreshness'
import { FloatingTerminalOrchestrationDialog } from './FloatingTerminalOrchestrationDialog'

const mocks = vi.hoisted(() => ({
  canUseSkillFreshness: true,
  refreshOrchestrationSkill: vi.fn(async () => true),
  recordFeatureInteraction: vi.fn()
}))

// Why: these tests count the freshness plans; the button's own plan is covered elsewhere.
vi.mock('@/hooks/use-bundled-skill-install-action', () => ({
  useBundledSkillInstallAction: () => ({ kind: 'run' })
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    agentRuntime: undefined,
    discoveryTarget: undefined,
    installDisabledReason: null,
    canUseSkillFreshness: mocks.canUseSkillFreshness,
    bundledSkillTarget: mocks.canUseSkillFreshness ? { kind: 'local' } : null
  })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkill: () => ({
    installed: true,
    loading: false,
    error: null,
    refresh: mocks.refreshOrchestrationSkill
  }),
  notifyInstalledAgentSkillsChanged: vi.fn(),
  notifyInstalledAgentSkillsRefreshed: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ recordFeatureInteraction: mocks.recordFeatureInteraction })
  })
}))

function plan(updateNames: string[]): BundledSkillPlan {
  return planOf(updateNames.map((name) => sharedEntry(name, 'update')))
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function recheckButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === 'Re-check'
  )
}

async function renderDialog(): Promise<void> {
  await act(async () => {
    root?.render(
      <FloatingTerminalOrchestrationDialog
        open
        onOpenChange={vi.fn()}
        onSetupStateChange={vi.fn()}
      />
    )
  })
  await act(async () => {})
}

describe('FloatingTerminalOrchestrationDialog freshness', () => {
  beforeEach(() => {
    _skillFreshnessCacheForTests.reset()
    mocks.canUseSkillFreshness = true
    mocks.refreshOrchestrationSkill.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
    Reflect.deleteProperty(window, 'api')
  })

  it('refreshes the local freshness verdict after presence re-check completes', async () => {
    const bundledPlan = vi
      .fn()
      .mockResolvedValueOnce(plan(['orchestration']))
      .mockResolvedValueOnce(plan([]))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double implements only the preload methods this code path calls.
    window.api = {
      skills: { bundledPlan },
      cli: { getInstallStatus: vi.fn().mockResolvedValue({ onPath: true }) }
    } as never

    await renderDialog()
    expect(bundledPlan).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Update available')

    await act(async () => {
      recheckButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(mocks.refreshOrchestrationSkill).toHaveBeenCalledOnce()
    expect(bundledPlan).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('Update available')
  })
})
