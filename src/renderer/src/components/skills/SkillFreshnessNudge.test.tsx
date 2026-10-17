// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import {
  blockedPlan,
  currentPlan,
  freshnessInventory,
  sharedLocation,
  skillPlan,
  updatablePlan
} from '@/lib/bundled-skill-plan-fixtures'
import { SkillFreshnessNudge } from './SkillFreshnessNudge'

const mocks = vi.hoisted(() => ({
  dismissed: [] as string[],
  updateSettings: vi.fn(),
  toastInfo: vi.fn(),
  toastDismiss: vi.fn(),
  requestDialog: vi.fn(),
  settingsLoaded: true,
  canUseLocalSkillFreshness: true,
  freshnessEnabled: true,
  inventory: null as SkillFreshnessInventory | null,
  error: null as string | null
}))

function eligibleInventory(): SkillFreshnessInventory {
  return freshnessInventory(updatablePlan('orca-cli'))
}

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: (enabled = true) => {
    mocks.freshnessEnabled = enabled
    return {
      inventory: mocks.inventory,
      loading: false,
      error: mocks.error,
      refresh: vi.fn()
    }
  }
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    canUseLocalSkillFreshness: mocks.canUseLocalSkillFreshness
  })
}))

vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, dismiss: mocks.toastDismiss }
}))

vi.mock('./skill-freshness-update-dialog', () => ({
  requestSkillFreshnessUpdateDialog: mocks.requestDialog
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

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderNudge(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<SkillFreshnessNudge />)
  })
}

async function rerenderNudge(): Promise<void> {
  await act(async () => {
    root?.render(<SkillFreshnessNudge />)
  })
}

const DISMISSAL_KEY = ['/home/.agents/skills/orca-cli', 'orca-cli', 'current'].join('\0')

describe('SkillFreshnessNudge', () => {
  beforeEach(() => {
    mocks.dismissed = []
    mocks.settingsLoaded = true
    mocks.canUseLocalSkillFreshness = true
    mocks.freshnessEnabled = true
    mocks.inventory = eligibleInventory()
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
    container?.remove()
    container = null
  })

  it('lingers without an auto-close timer or auto-close dismissal write', async () => {
    await renderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    const options = mocks.toastInfo.mock.calls[0]?.[1]
    expect(options.duration).toBe(Number.POSITIVE_INFINITY)
    expect(options.onAutoClose).toBeUndefined()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('nudges only for skills the install plan would update', async () => {
    mocks.inventory = freshnessInventory(
      updatablePlan('orca-cli'),
      blockedPlan('computer-use', 'not-installed-by-orca'),
      currentPlan('orchestration'),
      // Why: a skill whose only copy is someone else's is never installed by an update.
      skillPlan('orca-linear', [sharedLocation('orca-linear', 'install')])
    )
    await renderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    expect(mocks.toastInfo.mock.calls[0]?.[0]).toBe('An installed Orca skill is out of date')
    expect(mocks.toastInfo.mock.calls[0]?.[1].description).toContain('Update orca-cli so')
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

    mocks.inventory = { ...freshnessInventory(currentPlan('orca-cli')), scannedAt: 2 }
    await rerenderNudge()
    // Sonner invokes onDismiss for programmatic dismissals on its next render.
    options.onDismiss()

    expect(mocks.toastDismiss).toHaveBeenCalledWith('freshness-toast')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('retracts a stale nudge when re-inventory fails', async () => {
    await renderNudge()
    const options = mocks.toastInfo.mock.calls[0]?.[1]

    mocks.inventory = null
    mocks.error = 'scan failed'
    await rerenderNudge()
    options.onDismiss()

    expect(mocks.toastDismiss).toHaveBeenCalledWith('freshness-toast')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('retracts an active local nudge when runtime freshness becomes unavailable', async () => {
    await renderNudge()
    const options = mocks.toastInfo.mock.calls[0]?.[1]

    mocks.canUseLocalSkillFreshness = false
    await rerenderNudge()
    options.onDismiss()

    expect(mocks.freshnessEnabled).toBe(false)
    expect(mocks.toastDismiss).toHaveBeenCalledWith('freshness-toast')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('persists the skill and package key once on explicit dismissal', async () => {
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
    // A fresh inventory object with identical content re-runs the effect.
    mocks.inventory = eligibleInventory()
    await rerenderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a nudge for an already dismissed exact tuple', async () => {
    mocks.dismissed = [DISMISSAL_KEY]

    await renderNudge()

    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('nudges again for the next Orca version of a dismissed skill', async () => {
    mocks.dismissed = [DISMISSAL_KEY]
    mocks.inventory = freshnessInventory({ ...updatablePlan('orca-cli'), packageDigest: 'next' })

    await renderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('waits for persisted settings before deciding whether to nudge', async () => {
    mocks.settingsLoaded = false

    await renderNudge()

    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })
})
