// @vitest-environment happy-dom

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { useOnboardingAgentSurface } from './use-onboarding-agent-surface'
import { usePersistCurrentStep } from './use-onboarding-flow-persistence'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import type * as HostStructuredAgents from '@/runtime/host-structured-agents'

vi.mock('@/runtime/host-structured-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof HostStructuredAgents>()),
  relearnHostStructuredAgents: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

let root: Root
let container: HTMLDivElement
const initialState = useAppStore.getState()
const initialApi = window.api

function Probe() {
  const settings = useAppStore((state) => state.settings)
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>('aider')
  const agentInteractedRef = useRef(false)
  const [step, setStep] = useState<'agent' | 'theme'>('agent')
  const updateSettings = useAppStore((state) => state.updateSettings)
  const flow = useOnboardingAgentSurface({
    settings,
    selectedAgent,
    setSelectedAgent,
    agentInteractedRef
  })
  const persist = usePersistCurrentStep({
    currentStepId: step,
    agentSurface: flow.agentSurface,
    selectedAgent,
    agentInteractedRef,
    yoloPermissions: false,
    yoloPermissionsChosen: { current: false },
    theme: 'dark',
    settings,
    updateSettings,
    onboardingChecklist: getDefaultOnboardingState().checklist,
    onOnboardingChange: () => {},
    setError: () => {}
  })
  return (
    <>
      <button onClick={() => flow.setAgentSurface('chat')}>Chat</button>
      <button
        onClick={() => {
          agentInteractedRef.current = true
          setSelectedAgent('aider')
        }}
      >
        Pick Aider
      </button>
      <button
        data-save
        onClick={async () => {
          if ((await persist()).ok) {
            setStep('theme')
          }
        }}
      >
        Continue
      </button>
      <output data-step={step}>{selectedAgent}</output>
    </>
  )
}

function choose(label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent === label
  )
  if (!button) {
    throw new Error(`Missing ${label} button`)
  }
  act(() => button.click())
}

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'aider' },
    updateSettings: async (updates) => {
      const settings = useAppStore.getState().settings
      if (!settings) {
        throw new Error('Missing settings')
      }
      useAppStore.setState({ settings: { ...settings, ...updates } })
    },
    ensureNativeDetectedAgents: vi.fn().mockResolvedValue([]),
    localDetectedAgentIdsByContext: {}
  })
  Reflect.set(window, 'api', {
    onboarding: {
      update: async (updates: Partial<OnboardingState>) => ({
        ...getDefaultOnboardingState(),
        ...updates
      })
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(initialState, true)
  Reflect.set(window, 'api', initialApi)
})

it.each([true, false])(
  'selects Chat regardless of whether detection finishes first (%s)',
  (first) => {
    act(() => root.render(<Probe />))
    const detect = () =>
      act(() => useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['codex'] } }))
    if (first) {
      detect()
    }
    choose('Chat')
    if (!first) {
      detect()
    }
    expect(container.querySelector('output')?.textContent).toBe('codex')
  }
)

it('preserves an explicit terminal-only pick when detection settles', () => {
  act(() => root.render(<Probe />))
  choose('Chat')
  choose('Pick Aider')
  act(() => useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['codex'] } }))
  expect(container.querySelector('output')?.textContent).toBe('aider')
})

it('keeps provider opt-outs when choosing an installed Chat default', () => {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), nativeChatProviders: { claude: false } },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  act(() => root.render(<Probe />))
  choose('Chat')
  expect(container.querySelector('output')?.textContent).toBe('codex')
  expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({ claude: false })
})

it('keeps the confirmed default when native detection finishes after the agent page', async () => {
  act(() => root.render(<Probe />))
  choose('Chat')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-save]')?.click())
  expect(container.querySelector('output')?.dataset.step).toBe('theme')
  expect(useAppStore.getState().settings?.defaultTuiAgent).toBe('aider')

  act(() => useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['codex'] } }))
  expect(container.querySelector('output')?.textContent).toBe('aider')
  expect(useAppStore.getState().settings?.defaultTuiAgent).toBe('aider')
})
