// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  FEATURE_WALL_SETUP_STEP_IDS,
  getFeatureWallSetupSteps
} from '../../../../shared/feature-wall-setup-steps'
import type * as HostStructuredAgents from '@/runtime/host-structured-agents'
import { FeatureWallSetupChecklist } from './FeatureWallSetupChecklist'

vi.mock('@/runtime/host-structured-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof HostStructuredAgents>()),
  relearnHostStructuredAgents: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

let root: Root
let container: HTMLDivElement
const initialState = useAppStore.getState()

const progress = {
  ready: true,
  stepDone: Object.fromEntries(FEATURE_WALL_SETUP_STEP_IDS.map((id) => [id, false])) as Record<
    (typeof FEATURE_WALL_SETUP_STEP_IDS)[number],
    boolean
  >,
  coreDoneCount: 0,
  coreTotal: FEATURE_WALL_SETUP_STEP_IDS.length
}

function renderDefaultAgentStep(settings: Partial<GlobalSettings>): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'claude', ...settings },
    updateSettings: async (updates) => {
      const current = useAppStore.getState().settings
      if (!current) {
        throw new Error('Missing settings')
      }
      useAppStore.setState({ settings: { ...current, ...updates } })
    },
    refreshDetectedAgents: vi.fn().mockResolvedValue(undefined),
    ensureNativeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'aider']),
    detectedAgentIds: ['claude', 'aider'],
    localDetectedAgentIdsByContext: { host: ['claude', 'aider'] }
  })
  const step = getFeatureWallSetupSteps().find((candidate) => candidate.id === 'default-agent')
  act(() =>
    root.render(
      <TooltipProvider>
        <FeatureWallSetupChecklist
          activeStep={step ?? null}
          progress={progress}
          onSelectStep={() => {}}
          onOrchestrationSkillInstalledChange={() => {}}
          onBrowserUseSkillInstalledChange={() => {}}
        />
      </TooltipProvider>
    )
  )
}

function radio(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((el) =>
    el.textContent?.startsWith(label)
  )
  if (!match) {
    throw new Error(`Missing ${label} radio`)
  }
  return match
}

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(initialState, true)
})

describe('setup guide default agent step', () => {
  it('switches between Chat UI and Terminal and saves the choice right away', () => {
    renderDefaultAgentStep({ experimentalNativeChat: false })

    expect(radio('Terminal UI').getAttribute('aria-checked')).toBe('true')
    // The inline switch replaces the "Turn on now" tip.
    expect(container.textContent).not.toContain('Turn on now')

    act(() => radio('Chat UI').click())

    expect(useAppStore.getState().settings?.experimentalNativeChat).toBe(true)
    expect(radio('Chat UI').getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('[title="Aider"]')?.textContent).toContain('Terminal')

    act(() => radio('Terminal UI').click())

    expect(useAppStore.getState().settings?.experimentalNativeChat).toBe(false)
  })

  it('shows and saves the Yolo mode setting', () => {
    renderDefaultAgentStep({ agentPermissionDefault: 'own' })
    const yolo = container.querySelector<HTMLButtonElement>('[role="switch"]')

    expect(yolo?.getAttribute('aria-checked')).toBe('false')

    act(() => yolo?.click())

    expect(useAppStore.getState().settings?.agentPermissionDefault).toBe('full-access')
    expect(yolo?.getAttribute('aria-checked')).toBe('true')
  })
})
