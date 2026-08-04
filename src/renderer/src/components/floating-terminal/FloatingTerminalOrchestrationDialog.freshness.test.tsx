// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import { _skillFreshnessCacheForTests } from '@/hooks/useSkillFreshness'
import { FloatingTerminalOrchestrationDialog } from './FloatingTerminalOrchestrationDialog'

const mocks = vi.hoisted(() => ({
  canUseLocalSkillFreshness: true,
  refreshOrchestrationSkill: vi.fn(async () => true),
  recordFeatureInteraction: vi.fn()
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    agentRuntime: undefined,
    discoveryTarget: undefined,
    terminalShellOverride: undefined,
    installDisabledReason: null,
    canUseLocalSkillFreshness: mocks.canUseLocalSkillFreshness
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

vi.mock('@/components/settings/CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: (command: string) => command,
  buildSkillSetupTerminalCommand: (command: string) => command,
  ensureWslCliAvailableForAgentSkillTerminal: vi.fn(),
  getWslCliDistroRequest: () => undefined
}))

vi.mock('@/components/onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: () => null
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ recordFeatureInteraction: mocks.recordFeatureInteraction })
  })
}))

function inventory(eligibleUpdateNames: string[]): SkillFreshnessInventory {
  return { schemaVersion: 1, installations: [], eligibleUpdateNames, scanIssues: [], scannedAt: 1 }
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
    mocks.canUseLocalSkillFreshness = true
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
    const freshnessInventory = vi
      .fn()
      .mockResolvedValueOnce(inventory(['orchestration']))
      .mockResolvedValueOnce(inventory([]))
    window.api = {
      skills: { freshnessInventory },
      cli: { getInstallStatus: vi.fn().mockResolvedValue({ onPath: true }) }
    } as never

    await renderDialog()
    expect(freshnessInventory).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Update available')

    await act(async () => {
      recheckButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(mocks.refreshOrchestrationSkill).toHaveBeenCalledOnce()
    expect(freshnessInventory).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('Update available')
  })

  it('never reads client freshness for an SSH-owned skill', async () => {
    mocks.canUseLocalSkillFreshness = false
    const freshnessInventory = vi.fn().mockResolvedValue(inventory([]))
    window.api = {
      skills: { freshnessInventory },
      cli: { getInstallStatus: vi.fn().mockResolvedValue({ onPath: true }) }
    } as never

    await renderDialog()
    expect(document.body.textContent).toContain('Installed')

    await act(async () => {
      recheckButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(mocks.refreshOrchestrationSkill).toHaveBeenCalledOnce()
    expect(freshnessInventory).not.toHaveBeenCalled()
  })
})
