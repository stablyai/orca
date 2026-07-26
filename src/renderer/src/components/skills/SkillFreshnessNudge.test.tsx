// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessInventory
} from '../../../../shared/skill-freshness'
import { SkillFreshnessNudge } from './SkillFreshnessNudge'

const mocks = vi.hoisted(() => ({
  dismissed: [] as string[],
  updateSettings: vi.fn(),
  toastInfo: vi.fn(),
  toastDismiss: vi.fn(),
  requestDialog: vi.fn(),
  settingsLoaded: true,
  inventory: null as SkillFreshnessInventory | null,
  error: null as string | null
}))

function placement(
  overrides: Partial<SkillFreshnessInstallation> = {}
): SkillFreshnessInstallation {
  return {
    id: 'orca-cli',
    name: 'orca-cli',
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: '/home/.agents/skills/orca-cli',
    resolvedPath: '/home/.agents/skills/orca-cli',
    physicalIdentity: 'physical-orca-cli',
    topology: 'canonical-copy',
    status: 'outdated',
    installedReleaseRevision: 1,
    installedAppVersion: '1.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'current',
    currentAppVersion: '2.0.0',
    observedPackageDigest: 'old',
    errorCategory: null,
    ...overrides
  }
}

function eligibleInventory(): SkillFreshnessInventory {
  return {
    schemaVersion: 1,
    installations: [placement()],
    eligibleUpdateNames: ['orca-cli'],
    scannedAt: 1
  }
}

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    inventory: mocks.inventory,
    loading: false,
    error: mocks.error,
    refresh: vi.fn()
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

const DISMISSAL_KEY = ['physical-orca-cli', 'orca-cli', '2'].join('\0')

describe('SkillFreshnessNudge', () => {
  beforeEach(() => {
    mocks.dismissed = []
    mocks.settingsLoaded = true
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

    mocks.inventory = {
      schemaVersion: 1,
      installations: [placement({ status: 'current', observedPackageDigest: 'current' })],
      eligibleUpdateNames: [],
      scannedAt: 2
    }
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

  it('persists the exact placement/revision key once on explicit dismissal', async () => {
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

  it('does not nudge for a poisoned name with no eligible update', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      installations: [placement(), placement({ id: 'repo-copy', topology: 'repo-scope' })],
      eligibleUpdateNames: [],
      scannedAt: 1
    }

    await renderNudge()

    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('waits for persisted settings before deciding whether to nudge', async () => {
    mocks.settingsLoaded = false

    await renderNudge()

    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })
})
