// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { bundledSkillNudgeKey } from '../../../../shared/bundled-skill-summary'
import { installBodyOverlayAttributes } from '@/lib/body-overlay-attributes'
import { SkillFreshnessNudge } from './SkillFreshnessNudge'
import { planEntry, planOf, planOp, sharedEntry } from './bundled-skill-plan-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  dismissed: [] as string[],
  updateSettings: vi.fn(),
  toastInfo: vi.fn(),
  toastDismiss: vi.fn(),
  requestDialog: vi.fn(),
  settingsLoaded: true,
  canUseSkillFreshness: true,
  freshnessEnabled: true,
  plan: ((): BundledSkillPlan | null => null)(),
  error: null as string | null
}))

function updatePlan(): BundledSkillPlan {
  return planOf([sharedEntry('orca-cli', 'update')])
}

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: (target: unknown) => {
    mocks.freshnessEnabled = target !== null
    return {
      plan: mocks.plan,
      unsupported: null,
      loading: false,
      error: mocks.error,
      refresh: vi.fn()
    }
  }
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    bundledSkillTarget: mocks.canUseSkillFreshness ? { kind: 'local' } : null
  })
}))

vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, dismiss: mocks.toastDismiss }
}))

vi.mock('./skill-freshness-update-dialog', () => ({
  requestSkillFreshnessUpdateDialog: mocks.requestDialog,
  getSkillFreshnessUpdateDialogRequest: () => false,
  subscribeSkillFreshnessUpdateDialog: () => () => {}
}))

vi.mock('@/store', () => {
  const state = () => ({
    settings: mocks.settingsLoaded ? { dismissedSkillFreshnessNudges: mocks.dismissed } : null,
    updateSettings: mocks.updateSettings
  })
  const useAppStore = (selector: (value: ReturnType<typeof state>) => unknown) => selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

let disposeOverlayObserver: () => void
let overlay: HTMLDivElement | null = null
let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderNudge(startupPromptsFinished = true): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<SkillFreshnessNudge startupPromptsFinished={startupPromptsFinished} />)
  })
}

async function rerenderNudge(startupPromptsFinished = true): Promise<void> {
  await act(async () => {
    root?.render(<SkillFreshnessNudge startupPromptsFinished={startupPromptsFinished} />)
  })
}

const DISMISSAL_KEY = bundledSkillNudgeKey('local', updatePlan()) ?? ''

describe('SkillFreshnessNudge', () => {
  beforeEach(() => {
    disposeOverlayObserver = installBodyOverlayAttributes()
    mocks.dismissed = []
    mocks.settingsLoaded = true
    mocks.canUseSkillFreshness = true
    mocks.freshnessEnabled = true
    mocks.plan = updatePlan()
    mocks.error = null
    mocks.updateSettings.mockReset()
    mocks.updateSettings.mockResolvedValue(undefined)
    mocks.toastInfo.mockReset()
    mocks.toastInfo.mockReturnValue('freshness-toast')
    mocks.toastDismiss.mockReset()
    mocks.requestDialog.mockReset()
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    disposeOverlayObserver()
    overlay?.remove()
    overlay = null
    container?.remove()
    container = null
  })

  it('defers the nudge until startup prompts finish without consuming its fingerprint', async () => {
    await renderNudge(false)
    await rerenderNudge(false)
    expect(mocks.toastInfo).not.toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    await rerenderNudge(true)
    await rerenderNudge(true)
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('does not show an update resolved while startup prompts were open', async () => {
    await renderNudge(false)
    mocks.plan = planOf([sharedEntry('orca-cli', 'keep')])
    await rerenderNudge(true)
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it.each(['dialog-overlay', 'sheet-overlay', 'onboarding'])(
    'waits for a body-level %s outside activeModal to close',
    async (kind) => {
      overlay = document.createElement('div')
      if (kind === 'onboarding') {
        overlay.setAttribute('data-onboarding-overlay', '')
      } else {
        overlay.dataset.slot = kind
      }
      document.body.appendChild(overlay)
      await renderNudge()
      expect(mocks.toastInfo).not.toHaveBeenCalled()

      await act(async () => {
        overlay?.remove()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    }
  )

  it('retracts for an independently opened dialog and re-offers after the last dialog closes', async () => {
    await renderNudge()
    const original = mocks.toastInfo.mock.calls[0]?.[1]
    overlay = document.createElement('div')
    overlay.dataset.slot = 'dialog-overlay'
    await act(async () => {
      if (overlay) {
        document.body.appendChild(overlay)
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastDismiss).toHaveBeenCalledWith('freshness-toast')
    original.onDismiss()
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    const secondOverlay = document.createElement('div')
    secondOverlay.dataset.slot = 'sheet-overlay'
    await act(async () => {
      document.body.appendChild(secondOverlay)
      overlay?.remove()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    await act(async () => {
      secondOverlay.remove()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2)
    mocks.toastInfo.mock.calls[1]?.[1].action.onClick()
    expect(mocks.requestDialog).toHaveBeenCalledTimes(1)
  })

  it('re-offers after the startup gate closes temporarily, without persisting a dismissal', async () => {
    await renderNudge()
    const original = mocks.toastInfo.mock.calls[0]?.[1]
    await rerenderNudge(false)
    original.onDismiss()
    expect(mocks.toastDismiss).toHaveBeenCalledWith('freshness-toast')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    await rerenderNudge(true)
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2)
  })

  it('does not re-offer an explicitly dismissed nudge when the gate reopens', async () => {
    await renderNudge()
    mocks.toastInfo.mock.calls[0]?.[1].onDismiss()
    await rerenderNudge(false)
    await rerenderNudge(true)
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('lingers without an auto-close timer or auto-close dismissal write', async () => {
    await renderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    const options = mocks.toastInfo.mock.calls[0]?.[1]
    expect(options.duration).toBe(Number.POSITIVE_INFINITY)
    expect(options.onAutoClose).toBeUndefined()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('counts only skills the plan would update', async () => {
    mocks.plan = planOf([
      sharedEntry('orca-cli', 'update'),
      sharedEntry('computer-use', 'keep'),
      planEntry('orchestration', [
        planOp('keep', '/home/u/.agents/skills/orchestration'),
        planOp('leave', '/home/u/.claude/skills/orchestration', { reason: 'edited' })
      ])
    ])
    await renderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    expect(mocks.toastInfo.mock.calls[0]?.[0]).toBe('An installed Orca skill is out of date')
    expect(mocks.toastInfo.mock.calls[0]?.[1].description).toContain('Update orca-cli so')
  })

  it('raises no nudge when the plan only links a newly detected agent', async () => {
    mocks.plan = planOf([
      planEntry('orca-cli', [
        planOp('keep', '/home/u/.agents/skills/orca-cli'),
        planOp('link', '/home/u/.claude/skills/orca-cli')
      ])
    ])
    await renderNudge()

    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('opens the update dialog on action click without persisting a dismissal', async () => {
    await renderNudge()

    const options = mocks.toastInfo.mock.calls[0]?.[1]
    options.action.onClick()
    options.onDismiss()

    expect(mocks.requestDialog).toHaveBeenCalledTimes(1)
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('retracts a resolved nudge without recording a dismissal', async () => {
    await renderNudge()
    const options = mocks.toastInfo.mock.calls[0]?.[1]

    mocks.plan = planOf([sharedEntry('orca-cli', 'keep')])
    await rerenderNudge()
    // Sonner invokes onDismiss for programmatic dismissals on its next render.
    options.onDismiss()

    expect(mocks.toastDismiss).toHaveBeenCalledWith('freshness-toast')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('retracts a stale nudge when re-planning fails', async () => {
    await renderNudge()
    const options = mocks.toastInfo.mock.calls[0]?.[1]

    mocks.plan = null
    mocks.error = 'plan failed'
    await rerenderNudge()
    options.onDismiss()

    expect(mocks.toastDismiss).toHaveBeenCalledWith('freshness-toast')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('retracts an active local nudge when runtime freshness becomes unavailable', async () => {
    await renderNudge()
    const options = mocks.toastInfo.mock.calls[0]?.[1]

    mocks.canUseSkillFreshness = false
    await rerenderNudge()
    options.onDismiss()

    expect(mocks.freshnessEnabled).toBe(false)
    expect(mocks.toastDismiss).toHaveBeenCalledWith('freshness-toast')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('persists the plan nudge key once on explicit dismissal', async () => {
    await renderNudge()

    const options = mocks.toastInfo.mock.calls[0]?.[1]
    options.onDismiss()
    options.onDismiss()

    expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      dismissedSkillFreshnessNudges: [DISMISSAL_KEY]
    })
  })

  it('does not repeat the same nudge within a session', async () => {
    await renderNudge()
    // A fresh plan object with identical content re-runs the effect.
    mocks.plan = updatePlan()
    await rerenderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a nudge for an already dismissed key', async () => {
    mocks.dismissed = [DISMISSAL_KEY]

    await renderNudge()

    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('nudges again when this build ships different bytes', async () => {
    mocks.dismissed = [DISMISSAL_KEY]
    mocks.plan = planOf([{ ...sharedEntry('orca-cli', 'update'), digest: 'c'.repeat(64) }])

    await renderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('waits for persisted settings before deciding whether to nudge', async () => {
    mocks.settingsLoaded = false

    await renderNudge()

    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })
})
