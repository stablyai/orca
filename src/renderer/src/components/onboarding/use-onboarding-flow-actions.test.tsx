// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useOnboardingFlowActions } from './use-onboarding-flow-actions'
import { OnboardingFooter } from './OnboardingFooter'
import { STEPS } from './use-onboarding-flow-types'
import type * as OnboardingFlowState from './onboarding-flow-state'

const { launch, prepareSkipped } = vi.hoisted(() => ({
  launch: vi.fn(async () => {}),
  prepareSkipped: vi.fn(async () => true)
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local'
}))
vi.mock('./onboarding-completion-agent-launch', () => ({
  launchOnboardingCompletionAgent: launch
}))
vi.mock('./onboarding-flow-state', async (original) => ({
  ...(await original<typeof OnboardingFlowState>()),
  prepareSkippedOnboardingPreferences: prepareSkipped
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const FINAL_STEP = STEPS.length - 1
const AGENT_STEP = STEPS.findIndex((step) => step.id === 'agent')

function renderActions(options: {
  workspaceId: string | null
  opensAddProject: boolean
  stepIndex: number
}) {
  const openModal = vi.fn()
  const closeWith = vi.fn(async () => true)
  const { result } = renderHook(() =>
    useOnboardingFlowActions({
      busyLabel: null,
      setBusyLabel: vi.fn(),
      setError: vi.fn(),
      currentStep: STEPS[options.stepIndex],
      consumeStepDurationMs: () => 10,
      trackTaskSourcesSnapshot: vi.fn(),
      settings: getDefaultSettings('/tmp'),
      persistCurrentStep: vi.fn(async () => ({ ok: true as const })),
      selectedWorkspaceId: options.workspaceId,
      opensAddProject: options.opensAddProject,
      closeWith,
      openModal,
      getNextStepIndex: (index) => index + 1,
      onOnboardingChange: vi.fn(),
      stepIndex: options.stepIndex,
      setStepIndex: vi.fn(),
      selectedAgent: 'claude',
      agentSurface: 'terminal',
      themeLookBaseline: null,
      setTheme: vi.fn(),
      updateSettings: vi.fn()
    })
  )
  return { result, openModal, closeWith }
}

describe('onboarding completion when the profile started on the landing page', () => {
  it.each([null, 'folder:home'])(
    'opens Add Project from the final step without starting an agent (workspace %s)',
    async (workspaceId) => {
      const { result, openModal, closeWith } = renderActions({
        workspaceId,
        opensAddProject: true,
        stepIndex: FINAL_STEP
      })
      await act(() => result.current.next())
      expect(closeWith).toHaveBeenCalledWith('completed', expect.any(Number), 'add_project_modal')
      expect(openModal).toHaveBeenCalledWith('add-repo')
      expect(launch).not.toHaveBeenCalled()
    }
  )

  it.each([null, 'folder:home'])(
    'opens Add Project when leaving early without starting an agent (workspace %s)',
    async (workspaceId) => {
      const { result, openModal, closeWith } = renderActions({
        workspaceId,
        opensAddProject: true,
        stepIndex: AGENT_STEP
      })
      await act(() => result.current.setUpLater())
      expect(closeWith).toHaveBeenCalledWith('completed', expect.any(Number), 'add_project_modal')
      expect(openModal).toHaveBeenCalledWith('add-repo')
      expect(launch).not.toHaveBeenCalled()
    }
  )
})

describe('onboarding completion in the home workspace', () => {
  it('starts the chosen agent in the workspace from the final step', async () => {
    const { result, openModal, closeWith } = renderActions({
      workspaceId: 'folder:home',
      opensAddProject: false,
      stepIndex: FINAL_STEP
    })
    await act(() => result.current.next())
    expect(closeWith).toHaveBeenCalledWith('completed', expect.any(Number), 'workspace')
    expect(launch).toHaveBeenCalledWith('folder:home', 'claude', 'local')
    expect(openModal).not.toHaveBeenCalled()
  })

  it('starts the chosen agent when leaving early', async () => {
    const { result, openModal, closeWith } = renderActions({
      workspaceId: 'folder:home',
      opensAddProject: false,
      stepIndex: AGENT_STEP
    })
    await act(() => result.current.setUpLater())
    expect(closeWith).toHaveBeenCalledWith('completed', expect.any(Number), 'workspace')
    expect(launch).toHaveBeenCalledWith('folder:home', 'claude', 'local')
    expect(openModal).not.toHaveBeenCalled()
  })

  it('still offers Add Project from the final step when there is no workspace', async () => {
    const { result, openModal } = renderActions({
      workspaceId: null,
      opensAddProject: false,
      stepIndex: FINAL_STEP
    })
    await act(() => result.current.next())
    expect(openModal).toHaveBeenCalledWith('add-repo')
    expect(launch).not.toHaveBeenCalled()
  })
})

type Handle = ReturnType<typeof useOnboardingFlowActions> & { stepIndex: number }

function renderLeavingEarly(opensAddProject: boolean) {
  const openModal = vi.fn()
  const closeWith = vi.fn(async () => true)
  const handle: { current: Handle | null } = { current: null }
  function Flow(): React.JSX.Element {
    const [busyLabel, setBusyLabel] = useState<string | null>(null)
    const [stepIndex, setStepIndex] = useState(AGENT_STEP)
    const actions = useOnboardingFlowActions({
      busyLabel,
      setBusyLabel,
      setError: vi.fn(),
      currentStep: STEPS[stepIndex],
      consumeStepDurationMs: () => 10,
      trackTaskSourcesSnapshot: vi.fn(),
      settings: getDefaultSettings('/tmp'),
      persistCurrentStep: vi.fn(async () => ({ ok: true as const })),
      selectedWorkspaceId: opensAddProject ? null : 'folder:home',
      opensAddProject,
      closeWith,
      openModal,
      getNextStepIndex: (index) => index + 1,
      onOnboardingChange: vi.fn(),
      stepIndex,
      setStepIndex,
      selectedAgent: 'claude',
      agentSurface: 'terminal',
      themeLookBaseline: null,
      setTheme: vi.fn(),
      updateSettings: vi.fn()
    })
    handle.current = { ...actions, stepIndex }
    return (
      <OnboardingFooter
        shouldShowSetUpLater
        opensAddProject={opensAddProject}
        locked={actions.locked}
        onSetUpLater={() => void actions.setUpLater()}
        stepIndex={stepIndex}
        onBack={() => setStepIndex((index) => index - 1)}
        showPrimary
        primaryBusy={Boolean(busyLabel)}
        primaryLabel={busyLabel ?? 'idle'}
        shortcutModifierLabel="Ctrl"
        onPrimary={vi.fn()}
      />
    )
  }
  render(<Flow />)
  const primary = () => screen.getAllByRole('button').at(-1)!
  const back = () => screen.getAllByRole('button')[1]
  return { handle, openModal, closeWith, primary, back }
}

function deferSave(): { finish: (saved: boolean) => Promise<void> } {
  let resolve: (saved: boolean) => void = () => {}
  prepareSkipped.mockImplementationOnce(() => new Promise<boolean>((done) => (resolve = done)))
  return {
    finish: async (saved) => {
      await act(async () => resolve(saved))
    }
  }
}

function holdClose(closeWith: ReturnType<typeof vi.fn>): { finish: () => Promise<void> } {
  let resolve: (closed: boolean) => void = () => {}
  closeWith.mockImplementationOnce(() => new Promise<boolean>((done) => (resolve = done)))
  return {
    finish: async () => {
      await act(async () => resolve(true))
    }
  }
}

describe('leaving onboarding early while choices are saving', () => {
  it('keeps the flow locked during the save, then names Add Project and opens it', async () => {
    const save = deferSave()
    const view = renderLeavingEarly(true)
    const idleLabel = view.primary().textContent
    await act(async () => fireEvent.click(screen.getAllByRole('button')[0]))
    const labelWhileSaving = view.primary().textContent

    expect(labelWhileSaving).toBe(idleLabel)
    expect(view.primary()).toHaveProperty('disabled', true)
    expect(view.back()).toHaveProperty('disabled', true)
    fireEvent.click(view.back())
    let dismissed = true
    await act(async () => {
      dismissed = await view.handle.current!.dismissOnboarding('keyboard')
    })
    expect(dismissed).toBe(false)
    expect(view.handle.current!.stepIndex).toBe(AGENT_STEP)
    expect(view.closeWith).not.toHaveBeenCalled()

    const close = holdClose(view.closeWith)
    await save.finish(true)
    expect(view.primary().textContent).not.toBe(labelWhileSaving)
    await close.finish()
    expect(view.closeWith).toHaveBeenCalledWith(
      'completed',
      expect.any(Number),
      'add_project_modal'
    )
    expect(view.openModal).toHaveBeenCalledWith('add-repo')
    expect(view.closeWith).toHaveBeenCalledTimes(1)
    expect(view.openModal).toHaveBeenCalledTimes(1)
    expect(view.handle.current!.stepIndex).toBe(AGENT_STEP)
  })

  it('releases the flow without opening Add Project when the save fails', async () => {
    const save = deferSave()
    const view = renderLeavingEarly(true)
    await act(async () => fireEvent.click(screen.getAllByRole('button')[0]))
    await save.finish(false)

    expect(view.openModal).not.toHaveBeenCalled()
    expect(view.primary()).toHaveProperty('disabled', false)
    expect(view.back()).toHaveProperty('disabled', false)
    await act(async () => {
      await view.handle.current!.dismissOnboarding('keyboard')
    })
    expect(view.closeWith).toHaveBeenCalledWith('dismissed', expect.any(Number), undefined, {
      durationMs: expect.any(Number),
      advancedVia: 'keyboard'
    })
  })

  it('keeps the same busy label from saving to closing in the home workspace', async () => {
    const save = deferSave()
    const view = renderLeavingEarly(false)
    await act(async () => fireEvent.click(screen.getAllByRole('button')[0]))
    const labelWhileSaving = view.primary().textContent
    const close = holdClose(view.closeWith)
    await save.finish(true)
    expect(view.primary().textContent).toBe(labelWhileSaving)
    await close.finish()
    expect(view.openModal).not.toHaveBeenCalled()
  })
})
