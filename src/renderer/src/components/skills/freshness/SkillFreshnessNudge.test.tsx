// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../../shared/bundled-skill-plan'
import { installBodyOverlayAttributes } from '@/lib/overlay-interaction/body-overlay-attributes'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { SkillFreshnessNudge } from './SkillFreshnessNudge'
import { planOf, sharedEntry } from '../bundled-skill-plan-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  toastInfo: vi.fn(),
  toastDismiss: vi.fn(),
  plan: ((): BundledSkillPlan | null => null)()
}))

vi.mock('@/hooks/skills/freshness/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    plan: mocks.plan,
    unsupported: null,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

vi.mock('@/hooks/skills/runtime/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: { kind: 'local' } })
}))

vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, dismiss: mocks.toastDismiss }
}))

vi.mock('./skill-freshness-update-dialog', () => ({
  requestSkillFreshnessUpdateDialog: vi.fn()
}))

vi.mock('./skill-freshness-auto-update', () => ({
  autoUpdateUnmodifiedSkills: () => new Set<string>()
}))

vi.mock('@/store/index', () => {
  const state = () => ({
    settings: { dismissedSkillFreshnessNudges: [] },
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

// Creation waits a frame so a dialog opening in the same update can mount first.
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

async function renderNudge(startupPromptsFinished: boolean): Promise<void> {
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(<SkillFreshnessNudge startupPromptsFinished={startupPromptsFinished} />)
    await nextFrame()
  })
}

async function flushObserver(change: () => void): Promise<void> {
  await act(async () => {
    change()
    await nextFrame()
  })
}

describe('SkillFreshnessNudge startup gate', () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    disposeOverlayObserver = installBodyOverlayAttributes()
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    mocks.updateSettings.mockReset()
    mocks.updateSettings.mockResolvedValue(undefined)
    mocks.toastInfo.mockReset()
    mocks.toastInfo.mockReturnValue('freshness-toast')
    mocks.toastDismiss.mockReset()
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

  it('waits for startup prompts to finish, then shows once', async () => {
    await renderNudge(false)
    await renderNudge(false)
    expect(mocks.toastInfo).not.toHaveBeenCalled()

    await renderNudge(true)
    await renderNudge(true)
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it.each(['dialog-overlay', 'onboarding'])('waits for a body-level %s to close', async (kind) => {
    overlay = document.createElement('div')
    if (kind === 'onboarding') {
      overlay.setAttribute('data-onboarding-overlay', '')
    } else {
      overlay.dataset.slot = kind
    }
    document.body.appendChild(overlay)
    await renderNudge(true)
    expect(mocks.toastInfo).not.toHaveBeenCalled()

    await flushObserver(() => overlay?.remove())
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('does not create the toast while a dialog opening in the same update mounts', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <>
          <SkillFreshnessNudge startupPromptsFinished />
          <Dialog open>
            <DialogContent>
              <DialogTitle>Opening</DialogTitle>
              <DialogDescription>Opens with the nudge</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      )
      await nextFrame()
    })
    expect(document.body.hasAttribute('data-modal-overlay-open')).toBe(true)
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('shows once after a dialog that blocked the pending frame closes', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const dialogOverlay = document.createElement('div')
    dialogOverlay.dataset.slot = 'dialog-overlay'
    overlay = dialogOverlay
    await act(async () => {
      root?.render(<SkillFreshnessNudge startupPromptsFinished />)
      // Connects after the effect scheduled its frame, before the frame runs.
      document.body.appendChild(dialogOverlay)
      await nextFrame()
    })
    expect(mocks.toastInfo).not.toHaveBeenCalled()

    await flushObserver(() => dialogOverlay.remove())
    await renderNudge(true)
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('keeps one toast through repeated dialogs and still saves a close', async () => {
    await renderNudge(true)
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const dialogOverlay = document.createElement('div')
      dialogOverlay.dataset.slot = 'dialog-overlay'
      await flushObserver(() => document.body.appendChild(dialogOverlay))
      expect(document.body.hasAttribute('data-modal-overlay-open')).toBe(true)
      await flushObserver(() => dialogOverlay.remove())
    }
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    expect(mocks.toastDismiss).not.toHaveBeenCalled()
    const options = mocks.toastInfo.mock.calls[0]?.[1]
    options.onDismiss()
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps the toast after a later startup modal closes the gate', async () => {
    await renderNudge(true)
    await renderNudge(false)
    await renderNudge(true)
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    expect(mocks.toastDismiss).not.toHaveBeenCalled()
  })
})
