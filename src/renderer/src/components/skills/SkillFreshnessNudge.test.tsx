// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { bundledSkillNudgeKey } from '../../../../shared/bundled-skill-summary'
import { SkillFreshnessNudge } from './SkillFreshnessNudge'
import {
  _resetSkillFreshnessAutoUpdate,
  _skillFreshnessAutoUpdateAttemptCount
} from './skill-freshness-auto-update'
import {
  _resetSkillUpdateRunStore,
  acknowledgeSkillUpdateRun,
  getLatestSkillUpdateRun,
  getSkillUpdateRun,
  startSkillUpdateRun
} from './skill-update-run-store'
import { planEntry, planOf, planOp, sharedEntry } from './bundled-skill-plan-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  dismissed: [] as string[],
  updateSettings: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  manualExecute: vi.fn(),
  toastDismiss: vi.fn(),
  requestDialog: vi.fn(),
  settingsLoaded: true,
  canUseSkillFreshness: true,
  freshnessEnabled: true,
  plan: ((): BundledSkillPlan | null => null)(),
  error: ((): string | null => null)(),
  execute: vi.fn(),
  notifyChanged: vi.fn()
}))

/** A hand-edited copy: Orca must ask before replacing it. */
function editedPlan(digest?: string): BundledSkillPlan {
  const entry = sharedEntry('orca-cli', 'leave', { reason: 'edited', replaceable: true })
  return planOf([digest ? { ...entry, digest } : entry])
}

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  autoUpdateBundledSkillsOnTarget: mocks.execute,
  executeBundledSkillsOnTarget: mocks.manualExecute
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notifyChanged
}))

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
  toast: { info: mocks.toastInfo, warning: mocks.toastWarning, dismiss: mocks.toastDismiss }
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

const DISMISSAL_KEY = bundledSkillNudgeKey('local', editedPlan()) ?? ''

describe('SkillFreshnessNudge', () => {
  beforeEach(() => {
    mocks.dismissed = []
    mocks.settingsLoaded = true
    mocks.canUseSkillFreshness = true
    mocks.freshnessEnabled = true
    mocks.plan = editedPlan()
    mocks.error = null
    mocks.execute.mockReset()
    mocks.execute.mockResolvedValue({ scope: 'global', skills: [] })
    mocks.notifyChanged.mockReset()
    _resetSkillFreshnessAutoUpdate()
    _resetSkillUpdateRunStore()
    mocks.toastWarning.mockReset()
    mocks.manualExecute.mockReset()
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
    mocks.plan = editedPlan()
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
    mocks.plan = editedPlan('c'.repeat(64))

    await renderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('silently updates every unedited skill without a nudge', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'update'), sharedEntry('orca-linear', 'update')])

    await renderNudge()
    await act(async () => {})

    expect(mocks.execute).toHaveBeenCalledWith({ kind: 'local' }, ['orca-cli', 'orca-linear'])
    expect(mocks.notifyChanged).toHaveBeenCalledTimes(1)
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('auto-updates the unedited skill and names only the repair and edited ones', async () => {
    mocks.plan = planOf([
      sharedEntry('orca-cli', 'update'),
      sharedEntry('orca-emulator', 'restore'),
      sharedEntry('orca-linear', 'leave', { reason: 'edited', replaceable: true })
    ])

    await renderNudge()

    expect(mocks.execute).toHaveBeenCalledWith({ kind: 'local' }, ['orca-cli'])
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    expect(mocks.toastInfo.mock.calls[0]?.[1].description).toContain('orca-emulator, orca-linear')
    expect(mocks.toastInfo.mock.calls[0]?.[1].description).not.toContain('orca-cli')

    // The re-plan after the silent update keeps the same nudge.
    mocks.plan = planOf(
      [
        sharedEntry('orca-cli', 'keep'),
        sharedEntry('orca-emulator', 'restore'),
        sharedEntry('orca-linear', 'leave', { reason: 'edited', replaceable: true })
      ],
      'c'.repeat(64)
    )
    await rerenderNudge()
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('asks about the edited location of a skill whose other location auto-updates', async () => {
    mocks.plan = planOf([
      planEntry('orca-cli', [
        planOp('update', '/home/u/.agents/skills/orca-cli'),
        planOp('leave', '/home/u/.claude/skills/orca-cli', { reason: 'edited', replaceable: true })
      ])
    ])

    await renderNudge()

    expect(mocks.execute).toHaveBeenCalledWith({ kind: 'local' }, ['orca-cli'])
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('prompts only for the skill whose silent update failed', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'update'), sharedEntry('orca-linear', 'update')])
    await renderNudge()
    await act(async () => {})
    expect(mocks.toastInfo).not.toHaveBeenCalled()

    // orca-linear's write failed, so the re-plan still offers the same update there.
    mocks.plan = planOf(
      [sharedEntry('orca-cli', 'keep'), sharedEntry('orca-linear', 'update')],
      'c'.repeat(64)
    )
    await rerenderNudge()

    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    expect(mocks.toastInfo.mock.calls[0]?.[1].description).toContain('Update orca-linear so')
  })

  it('asks before updating when the host cannot auto-update', async () => {
    mocks.execute.mockResolvedValue(null)
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    await renderNudge()
    await act(async () => {})

    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    await rerenderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('surfaces edits preserved in a backup instead of passing as a silent success', async () => {
    const backupPath = '/home/u/.agents/.orca-skill-backups/orca-cli-1'
    mocks.execute.mockResolvedValue({
      scope: 'global',
      skills: [
        {
          name: 'orca-cli',
          status: 'ran',
          ops: [
            { path: '/home/u/.agents/skills/orca-cli', kind: 'update', status: 'done', backupPath }
          ]
        }
      ]
    })
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])

    await renderNudge()
    await act(async () => {})

    expect(mocks.toastWarning).toHaveBeenCalledTimes(1)
    expect(mocks.toastWarning.mock.calls[0]?.[0]).toContain('orca-cli')
    expect(mocks.toastWarning.mock.calls[0]?.[1].description).toContain(backupPath)
  })

  it('shares target ownership with manual updates while a silent update runs', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.execute.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    await renderNudge()

    expect(getSkillUpdateRun('local').state).toBe('running')
    await startSkillUpdateRun({ target: { kind: 'local' }, names: [], planDigest: 'd', force: [] })
    expect(mocks.manualExecute).not.toHaveBeenCalled()

    await act(async () => finish({ scope: 'global', skills: [] }))
    expect(getSkillUpdateRun('local').state).toBe('idle')
  })

  it('does not start a silent update while a manual update owns the target', async () => {
    mocks.manualExecute.mockReturnValue(new Promise(() => {}))
    void startSkillUpdateRun({ target: { kind: 'local' }, names: [], planDigest: 'd', force: [] })
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])

    await renderNudge()

    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('shows a programmatically retracted nudge again when its skills return', async () => {
    const edited = sharedEntry('orca-linear', 'leave', { reason: 'edited', replaceable: true })
    mocks.plan = planOf([edited])
    await renderNudge()
    mocks.plan = planOf([edited, sharedEntry('orca-emulator', 'restore')], 'c'.repeat(64))
    await rerenderNudge()
    mocks.plan = planOf([edited], 'd'.repeat(64))
    await rerenderNudge()

    expect(mocks.toastInfo).toHaveBeenCalledTimes(3)
    expect(mocks.toastDismiss).toHaveBeenCalledTimes(2)
  })

  it('warns where edits remain when Orca could not back them up', async () => {
    const strandedPath = '/home/u/.agents/skills/.orca-cli.orca-old-1'
    mocks.execute.mockResolvedValue({
      scope: 'global',
      skills: [
        {
          name: 'orca-cli',
          status: 'ran',
          ops: [
            {
              path: '/home/u/.agents/skills/orca-cli',
              kind: 'update',
              status: 'failed',
              error: 'EACCES',
              strandedPath
            }
          ]
        }
      ]
    })
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])

    await renderNudge()
    await act(async () => {})

    expect(mocks.toastWarning).toHaveBeenCalledTimes(1)
    expect(mocks.toastWarning.mock.calls[0]?.[1].description).toContain(strandedPath)
    expect(mocks.toastWarning.mock.calls[0]?.[1].duration).toBe(Number.POSITIVE_INFINITY)
  })

  it('nudges about an old copy whose edits still await a backup', async () => {
    mocks.plan = planOf([
      sharedEntry('orca-cli', 'keep', {
        cleanup: [
          {
            path: '/home/u/.agents/skills/.orca-cli.orca-old-1',
            action: 'backup',
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: null }
          }
        ]
      })
    ])

    await renderNudge()

    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('never replaces an unacknowledged manual result with a silent run', async () => {
    mocks.manualExecute.mockRejectedValue(new Error('disk full'))
    await startSkillUpdateRun({
      target: { kind: 'local' },
      names: ['x'],
      planDigest: 'd',
      force: []
    })
    expect(getSkillUpdateRun('local').state).toBe('error')
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])

    await renderNudge()
    await act(async () => {})

    expect(mocks.execute).not.toHaveBeenCalled()
    expect(getSkillUpdateRun('local')).toMatchObject({ state: 'error', message: 'disk full' })
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })

  it('keeps a silent run out of the status bar after an acknowledged manual run', async () => {
    mocks.manualExecute.mockResolvedValue({ scope: 'global', skills: [] })
    await startSkillUpdateRun({
      target: { kind: 'local' },
      names: ['x'],
      planDigest: 'd',
      force: []
    })
    acknowledgeSkillUpdateRun('local')
    mocks.execute.mockReturnValue(new Promise(() => {}))
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])

    await renderNudge()

    expect(getSkillUpdateRun('local').state).toBe('running')
    expect(getLatestSkillUpdateRun().state).toBe('idle')
  })

  it('prunes attempts for states no longer observed but still suppresses unchanged retries', async () => {
    mocks.execute.mockResolvedValue(null)
    mocks.plan = planOf([sharedEntry('orca-cli', 'update'), sharedEntry('orca-linear', 'update')])
    await renderNudge()
    await act(async () => {})
    expect(_skillFreshnessAutoUpdateAttemptCount()).toBe(2)

    // Unchanged states stay settled: no retry.
    mocks.plan = planOf([sharedEntry('orca-cli', 'update'), sharedEntry('orca-linear', 'keep')])
    await rerenderNudge()
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(_skillFreshnessAutoUpdateAttemptCount()).toBe(1)

    mocks.plan = planOf([sharedEntry('orca-cli', 'keep'), sharedEntry('orca-linear', 'keep')])
    await rerenderNudge()
    expect(_skillFreshnessAutoUpdateAttemptCount()).toBe(0)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('warns about an uncertain outcome when the reply is lost after the host commits', async () => {
    const committed = planOf([sharedEntry('orca-cli', 'keep')], 'c'.repeat(64))
    mocks.execute.mockImplementation(async () => {
      // The host swapped the copy (possibly backing up a racing edit), then the connection dropped.
      mocks.plan = committed
      throw new Error('runtime connection lost')
    })
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])

    await renderNudge()
    await act(async () => {})
    await rerenderNudge()

    expect(mocks.toastWarning).toHaveBeenCalledTimes(1)
    const [title, options] = mocks.toastWarning.mock.calls[0] ?? []
    expect(title).toContain('This machine')
    expect(options.description).toContain('/home/u/.agents/.orca-skill-backups')
    expect(options.duration).toBe(Number.POSITIVE_INFINITY)
    expect(getSkillUpdateRun('local').state).toBe('idle')
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('hands an uncertain state to the nudge instead of retrying it', async () => {
    mocks.execute.mockRejectedValue(new Error('timed out'))
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    await renderNudge()
    await act(async () => {})

    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    await rerenderNudge()

    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1)
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  })
})
