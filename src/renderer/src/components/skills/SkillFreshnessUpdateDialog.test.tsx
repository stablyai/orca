// @vitest-environment happy-dom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessInventory,
  SkillUpdateRun
} from '../../../../shared/skill-freshness'
import { SkillFreshnessUpdateDialog } from './SkillFreshnessUpdateDialog'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  requestSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'
import { _resetSkillUpdateRunStore, SKILL_UPDATE_SUCCESS_LINGER_MS } from './skill-update-run-store'

const mocks = vi.hoisted(() => ({
  inventory: null as SkillFreshnessInventory | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  notifyChanged: vi.fn()
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    inventory: mocks.inventory,
    loading: mocks.loading,
    error: mocks.error,
    refresh: mocks.refresh
  })
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ canUseLocalSkillFreshness: true })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notifyChanged
}))

// Radix Dialog/Collapsible internals (portal, focus-scope) are exercised in
// Electron QA; here the content logic is what matters, so use plain wrappers.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-dialog-open="true">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/collapsible', () => ({
  // Forward data-* props: the unified skill row tags its Collapsible root with
  // the identifiers the assertions below read.
  Collapsible: ({
    children,
    defaultOpen = false,
    ...rest
  }: {
    children?: ReactNode
    defaultOpen?: boolean
  } & Record<string, unknown>) => {
    const [open] = useState(defaultOpen)
    return (
      <div {...rest} data-collapsible-open={String(open)}>
        {children}
      </div>
    )
  },
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  // Tagged so tests can prove WHERE content sits: this mock renders it whether
  // or not the disclosure is open, so presence in the DOM alone proves nothing.
  CollapsibleContent: ({ children }: { children?: ReactNode }) => (
    <div data-collapsible-content>{children}</div>
  )
}))

const skillsApi = {
  startUpdateRun: vi.fn(async () => ({ started: true as const })),
  cancelUpdateRun: vi.fn(async () => {}),
  acknowledgeUpdateRun: vi.fn(async () => {}),
  getUpdateRun: vi.fn(async (): Promise<SkillUpdateRun> => ({ state: 'idle' })),
  onUpdateRun: vi.fn((callback: (run: SkillUpdateRun) => void) => {
    pushRun = callback
    return () => {}
  })
}
let pushRun: ((run: SkillUpdateRun) => void) | null = null

function placement(
  name: string,
  overrides: Partial<SkillFreshnessInstallation> = {}
): SkillFreshnessInstallation {
  return {
    id: `${name}-${overrides.rootId ?? 'home-agents'}`,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${name}`,
    resolvedPath: `/home/.agents/skills/${name}`,
    physicalIdentity: `physical-${name}`,
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
    installations: [placement('orca-cli')],
    eligibleUpdateNames: ['orca-cli'],
    scanIssues: [],
    scannedAt: 1
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderDialog(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<SkillFreshnessUpdateDialog />)
  })
}

async function rerender(): Promise<void> {
  await act(async () => {
    root?.render(<SkillFreshnessUpdateDialog />)
  })
}

async function openViaRequest(): Promise<void> {
  await act(async () => {
    requestSkillFreshnessUpdateDialog()
  })
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.trim() === label
  )
}

async function clickButton(label: string): Promise<void> {
  const button = findButton(label)
  expect(button, `expected a "${label}" button`).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function emitRun(run: SkillUpdateRun): Promise<void> {
  await act(async () => {
    pushRun?.(run)
  })
}

describe('SkillFreshnessUpdateDialog', () => {
  beforeEach(() => {
    consumeSkillFreshnessUpdateDialogRequest()
    _resetSkillUpdateRunStore()
    pushRun = null
    mocks.inventory = eligibleInventory()
    mocks.loading = false
    mocks.error = null
    mocks.refresh.mockReset()
    mocks.notifyChanged.mockReset()
    skillsApi.startUpdateRun.mockClear()
    skillsApi.cancelUpdateRun.mockClear()
    skillsApi.acknowledgeUpdateRun.mockClear()
    skillsApi.getUpdateRun.mockClear()
    ;(window as unknown as { api: { skills: typeof skillsApi } }).api = { skills: skillsApi }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
  })

  it('stays closed until an open request arrives', async () => {
    await renderDialog()
    expect(container?.querySelector('[data-dialog-open]')).toBeNull()
  })

  it('offers a primary update action and never renders a terminal', async () => {
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain('Update skills')
    expect(container?.textContent).toContain('1 update available')
    expect(findButton('Update 1 skill')).toBeDefined()
    expect(container?.querySelector('[data-testid="update-terminal"]')).toBeNull()
    expect(container?.textContent).not.toContain('press Enter')
  })

  it('starts a background run with the eligible names', async () => {
    await renderDialog()
    await openViaRequest()
    await clickButton('Update 1 skill')

    expect(skillsApi.startUpdateRun).toHaveBeenCalledWith(['orca-cli'])
  })

  it('shows indeterminate progress and says the run survives closing', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({ state: 'running', names: ['orca-cli'], startedAt: 1, output: '' })

    expect(container?.textContent).toContain('Updating 1 skill…')
    expect(container?.textContent).toContain('keeps running in the background')
    expect(container?.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(
      container?.querySelector('[data-skill-row="orca-cli"]')?.getAttribute('data-state-label')
    ).toBe('pending')
  })

  it('does not cancel the run when the dialog is closed', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({ state: 'running', names: ['orca-cli'], startedAt: 1, output: '' })
    await clickButton('Close')

    expect(container?.querySelector('[data-dialog-open]')).toBeNull()
    expect(skillsApi.cancelUpdateRun).not.toHaveBeenCalled()
  })

  it('reports per-skill success once the run settles', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({
      state: 'success',
      names: ['orca-cli'],
      finishedAt: 2,
      output: '✓ Updated 1 skill(s)'
    })

    expect(container?.textContent).toContain('Updated 1 skill')
    expect(
      container?.querySelector('[data-skill-row="orca-cli"]')?.getAttribute('data-state-label')
    ).toBe('done')
    expect(findButton('Done')).toBeDefined()
    // The re-scan is what makes the result trustworthy, so it must be requested.
    expect(mocks.notifyChanged).toHaveBeenCalled()
  })

  it('attributes failures to the names the re-scan says are still outdated', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      installations: [placement('orca-cli'), placement('orchestration')],
      eligibleUpdateNames: ['orca-cli', 'orchestration'],
      scanIssues: [],
      scannedAt: 1
    }
    await renderDialog()
    await openViaRequest()
    await emitRun({
      state: 'error',
      names: ['orca-cli', 'orchestration'],
      failedNames: ['orchestration'],
      finishedAt: 3,
      output: '✗ Failed to update orchestration',
      message: 'skills update exited with code 1'
    })

    expect(container?.textContent).toContain('Updated 1 of 2 skills')
    expect(
      container?.querySelector('[data-skill-row="orca-cli"]')?.getAttribute('data-state-label')
    ).toBe('done')
    expect(
      container?.querySelector('[data-skill-row="orchestration"]')?.getAttribute('data-state-label')
    ).toBe('failed')
    expect(container?.textContent).toContain('skills update exited with code 1')
    expect(findButton('Retry')).toBeDefined()
  })

  it('keeps the same row elements across the whole run instead of swapping layouts', async () => {
    await renderDialog()
    await openViaRequest()
    const before = container?.querySelector('[data-skill-row="orca-cli"]')
    expect(before?.getAttribute('data-state-label')).toBe('available')

    await emitRun({ state: 'running', names: ['orca-cli'], startedAt: 1, output: '' })
    const during = container?.querySelector('[data-skill-row="orca-cli"]')
    expect(during).toBe(before)
    expect(during?.getAttribute('data-state-label')).toBe('pending')

    // The re-scan makes the skill current, which would otherwise drop it from
    // the group list and blank the row out mid-transition.
    mocks.inventory = {
      schemaVersion: 1,
      installations: [placement('orca-cli', { status: 'current', installedReleaseRevision: 2 })],
      eligibleUpdateNames: [],
      scanIssues: [],
      scannedAt: 5
    }
    await emitRun({ state: 'success', names: ['orca-cli'], finishedAt: 2, output: 'done' })
    await rerender()
    const after = container?.querySelector('[data-skill-row="orca-cli"]')
    expect(after).toBe(before)
    expect(after?.getAttribute('data-state-label')).toBe('done')
  })

  it('collapses each skill’s locations behind its own disclosure', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('orca-cli'),
        placement('orca-cli', {
          rootId: 'plugin',
          topology: 'plugin-cache',
          status: 'inaccessible'
        })
      ],
      eligibleUpdateNames: ['orca-cli'],
      scanIssues: [],
      scannedAt: 1
    }
    await renderDialog()
    await openViaRequest()

    const row = container?.querySelector('[data-skill-row="orca-cli"]')
    expect(row).not.toBeNull()
    // Closed by default — the paths are behind the row's own trigger.
    expect(row?.getAttribute('data-collapsible-open')).toBe('false')
    expect(container?.textContent).toContain('2 locations')
  })

  it('does not let the status-bar linger retire the result being read here', async () => {
    vi.useFakeTimers()
    try {
      await renderDialog()
      await openViaRequest()
      await emitRun({ state: 'success', names: ['orca-cli'], finishedAt: 2, output: 'done' })

      await act(async () => {
        vi.advanceTimersByTime(SKILL_UPDATE_SUCCESS_LINGER_MS * 3)
      })

      expect(skillsApi.acknowledgeUpdateRun).not.toHaveBeenCalled()
      expect(container?.textContent).toContain('Updated 1 skill')
      expect(findButton('Done')).toBeDefined()
      expect(
        container?.querySelector('[data-skill-row="orca-cli"]')?.getAttribute('data-state-label')
      ).toBe('done')

      // Closing is what hands the run back — it must not be left stuck.
      await clickButton('Done')
      expect(skillsApi.acknowledgeUpdateRun).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the captured log verbatim without parsing it', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({
      state: 'success',
      names: ['orca-cli'],
      finishedAt: 2,
      output: 'Checking skills from source: stablyai/orca\n  ✓ Updated orca-cli'
    })

    expect(container?.querySelector('pre')?.textContent).toContain(
      'Checking skills from source: stablyai/orca'
    )
  })

  it('shows the up-to-date state once every installation is current', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      installations: [placement('orca-cli', { status: 'current', installedReleaseRevision: 2 })],
      eligibleUpdateNames: [],
      scanIssues: [],
      scannedAt: 2
    }
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain('All installed Orca skills are up to date.')
    expect(findButton('Update 1 skill')).toBeUndefined()
  })

  it('shows why a skill was skipped without needing the disclosure', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      // Why: a read-only copy rather than a project one — a project-owned copy raises no
      // row at all now, so it cannot carry this assertion about how a row renders.
      installations: [placement('computer-use', { topology: 'read-only' })],
      eligibleUpdateNames: [],
      scanIssues: [],
      scannedAt: 3
    }
    await renderDialog()
    await openViaRequest()

    const row = container?.querySelector('[data-skill-row="computer-use"]')
    expect(container?.textContent).toContain('computer-use')
    expect(container?.textContent).toContain('Skipped')
    // The reason is the one thing a skipped row exists to say, so it lives
    // outside the disclosure — visible with the row still collapsed, and not
    // dependent on a mount-time `defaultOpen` a later re-scan could never re-fire.
    expect(row?.getAttribute('data-collapsible-open')).toBe('false')
    expect(container?.textContent).toContain('This copy is in a read-only location')
    // Assert the placement, not just the presence: moving it back inside the
    // disclosure would hide it in production but still satisfy `textContent`.
    expect(row?.querySelector('[data-collapsible-content]')?.textContent).not.toContain(
      'This copy is in a read-only location'
    )
  })

  it('raises no row for a skill whose only finding is a project-owned copy', async () => {
    // The reported bug: a pristine global install plus a drifted copy inside a work
    // directory. Orca only ever updates global skills, so a "Skipped" row here asserts
    // it considered an update it could never perform.
    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('computer-use', { status: 'current' }),
        placement('computer-use', {
          rootId: 'repo-work',
          sourceKind: 'repo',
          topology: 'repo-scope',
          status: 'unrecognized',
          unresolvedPath: '/home/projects/work/.agents/skills/computer-use',
          resolvedPath: '/home/projects/work/.agents/skills/computer-use',
          physicalIdentity: 'physical-repo-computer-use'
        })
      ],
      eligibleUpdateNames: [],
      scanIssues: [],
      scannedAt: 4
    }
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain('All installed Orca skills are up to date.')
    expect(container?.querySelector('[data-skill-row="computer-use"]')).toBeNull()
  })

  it('still lists a project copy when another placement earns the group', async () => {
    // The converse: ownership suppresses the group, never the visibility of a location
    // that exists. An outdated global copy earns the row, and the project copy has to
    // stay listed there so the user can see every place the skill lives.
    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('computer-use', { topology: 'read-only' }),
        placement('computer-use', {
          rootId: 'repo-work',
          sourceKind: 'repo',
          topology: 'repo-scope',
          status: 'unrecognized',
          unresolvedPath: '/home/projects/work/.agents/skills/computer-use',
          resolvedPath: '/home/projects/work/.agents/skills/computer-use',
          physicalIdentity: 'physical-repo-computer-use'
        })
      ],
      eligibleUpdateNames: [],
      scanIssues: [],
      scannedAt: 5
    }
    await renderDialog()
    await openViaRequest()

    const row = container?.querySelector('[data-skill-row="computer-use"]')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('/home/projects/work/.agents/skills/computer-use')
  })

  it('names the skill in the stale-record remedy so the command is runnable as-is', async () => {
    // Why: the reinstall advice only fires when the row hands its group name through
    // to skippedReason — dropping that argument silently degrades every stale-record
    // row to the generic sentence with no command to run.
    mocks.inventory = {
      schemaVersion: 1,
      installations: [placement('orchestration')],
      eligibleUpdateNames: [],
      scanIssues: [],
      scannedAt: 3
    }
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain(
      'npx skills add https://github.com/stablyai/orca --skill orchestration --global'
    )
  })

  it('keeps the stale-record remedy when a project copy is listed beside it', async () => {
    // The same stale-record row as above, plus the user's own project copy. That copy is
    // listed but was never judged, so letting it explain the skip replaced the only
    // runnable command with advice about a copy the user never asked Orca to update.
    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('orchestration'),
        placement('orchestration', {
          rootId: 'repo-work',
          sourceKind: 'repo',
          topology: 'repo-scope',
          status: 'unrecognized',
          unresolvedPath: '/home/projects/work/.agents/skills/orchestration',
          resolvedPath: '/home/projects/work/.agents/skills/orchestration',
          physicalIdentity: 'physical-repo-orchestration'
        })
      ],
      eligibleUpdateNames: [],
      scanIssues: [],
      scannedAt: 6
    }
    await renderDialog()
    await openViaRequest()

    const row = container?.querySelector('[data-skill-row="orchestration"]')
    expect(row?.textContent).toContain(
      'npx skills add https://github.com/stablyai/orca --skill orchestration --global'
    )
    expect(row?.textContent).not.toContain('This is a project skill, not a global one')
    // Still listed, though — ownership silences the explanation, never the location.
    expect(row?.textContent).toContain('/home/projects/work/.agents/skills/orchestration')
  })

  it('stays coherent while an idle re-scan is in flight', async () => {
    await renderDialog()
    await openViaRequest()
    // Re-check publishes {inventory: null, loading: true} synchronously. The rows
    // are retained, so the headline and the count must not be read off the live
    // snapshot and the retained one at the same time — that pairs a "0 updates
    // available" headline with rows badged "Update available".
    mocks.inventory = null
    mocks.loading = true
    await rerender()

    expect(container?.textContent).not.toContain('0 updates available')
    expect(container?.textContent).toContain('Checking installed Orca skills…')
    // The action keeps its place rather than reflowing the footer, but cannot
    // fire against bytes that are being re-read.
    const update = findButton('Update 1 skill')
    expect(update).toBeDefined()
    expect(update?.disabled).toBe(true)
    expect(
      container?.querySelector('[data-skill-row="orca-cli"]')?.getAttribute('data-state-label')
    ).toBe('available')
  })

  it('says it is stopping while the process tree is still being killed', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({ state: 'running', names: ['orca-cli'], startedAt: 1, output: '' })
    await clickButton('Stop')
    // Main holds the run `running` until the kill lands — that is what blocks a
    // second writer — so the button must not sit enabled and inert meanwhile.
    await emitRun({
      state: 'running',
      names: ['orca-cli'],
      startedAt: 1,
      output: '',
      stopping: true
    })

    const stopping = findButton('Stopping…')
    expect(stopping).toBeDefined()
    expect(stopping?.disabled).toBe(true)
    expect(findButton('Stop')).toBeUndefined()
    // The headline must not contradict the button — telling someone the update
    // "keeps running in the background" is the opposite of what Stop just did.
    expect(container?.textContent).toContain('Stopping the update…')
    expect(container?.textContent).not.toContain('keeps running in the background')
    expect(container?.textContent).not.toContain('Updating 1 skill…')
    // The primary button sits right next to "Stopping…" — it must not still be
    // announcing "Updating…", visually or to a screen reader.
    expect(findButton('Updating…')).toBeUndefined()
    expect(container?.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe(
      'Stopping the update…'
    )
  })

  it('re-reads the inventory after a run is stopped', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({ state: 'running', names: ['orca-cli'], startedAt: 1, output: '' })
    mocks.notifyChanged.mockClear()
    // A killed run may already have written several skills; leaving the pre-run
    // scan on screen would re-offer skills that are now current.
    await emitRun({ state: 'idle' })

    expect(mocks.notifyChanged).toHaveBeenCalled()
  })

  it('keeps the rows on screen while the settling re-scan is in flight', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({ state: 'success', names: ['orca-cli'], finishedAt: 2, output: 'done' })

    // Settling notifies every skills surface, and that refresh nulls the
    // inventory synchronously while it re-hashes every package on disk.
    mocks.inventory = null
    mocks.loading = true
    await rerender()

    expect(
      container?.querySelector('[data-skill-row="orca-cli"]')?.getAttribute('data-state-label')
    ).toBe('done')
    expect(container?.textContent).toContain('Updated 1 skill')
  })

  it('retries what failed rather than the emptied eligibility list', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({
      state: 'error',
      names: ['orca-cli'],
      failedNames: ['orca-cli'],
      finishedAt: 3,
      output: '',
      message: 'skills update exited with code 1'
    })
    // The settling re-scan has emptied `eligibleUpdateNames` by the time Retry
    // is on screen; retrying that list would spawn nothing at all.
    mocks.inventory = null
    mocks.loading = true
    await rerender()
    await clickButton('Retry')

    expect(skillsApi.startUpdateRun).toHaveBeenCalledWith(['orca-cli'])
  })

  it('offers a way out of a run that never finishes', async () => {
    await renderDialog()
    await openViaRequest()
    await emitRun({ state: 'running', names: ['orca-cli'], startedAt: 1, output: '' })
    await clickButton('Stop')

    expect(skillsApi.cancelUpdateRun).toHaveBeenCalledTimes(1)
  })

  it('surfaces a scan error instead of a stale summary', async () => {
    await renderDialog()
    await openViaRequest()
    // Prime a good scan first: the retained inventory must not survive into the
    // error state. That invariant lives in useSkillFreshness (every publish that
    // sets `error` also clears `loading`), so pin it from the side that depends
    // on it — otherwise a later "keep spinning while retrying" change would
    // silently start showing stale rows under an error.
    expect(container?.querySelector('[data-skill-row="orca-cli"]')).not.toBeNull()

    mocks.inventory = null
    mocks.error = 'Missing canonical agent skills root'
    await rerender()

    expect(container?.textContent).toContain('Missing canonical agent skills root')
    expect(container?.querySelector('[data-skill-row="orca-cli"]')).toBeNull()
    expect(findButton('Update 1 skill')).toBeUndefined()
  })
  it('shows incomplete plugin coverage without presenting a fabricated skill copy', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('orca-cli', { status: 'current', observedPackageDigest: 'current' })
      ],
      eligibleUpdateNames: [],
      scanIssues: [
        {
          rootId: 'codex-plugin-cache',
          sourceLabel: 'Codex plugin cache',
          path: '/home/.codex/plugins/cache/vendor/locked',
          reason: 'io-error',
          errorCode: 'EACCES'
        }
      ],
      scannedAt: 2
    }
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain(
      'Orca could not finish checking plugin-managed skills.'
    )
    expect(container?.textContent).toContain('/home/.codex/plugins/cache/vendor/locked')
    expect(container?.textContent).toContain('EACCES')
    expect(container?.textContent).not.toContain('All installed Orca skills are up to date.')
    // Why: the fabricated per-skill path is exactly what this change removed — the
    // unreadable folder must never be rendered as a copy of a named skill.
    expect(container?.textContent).not.toContain(
      '/home/.codex/plugins/cache/vendor/locked/orca-cli'
    )
  })

  // Why: the walk stopped early here, so claiming every copy is up to date would assert
  // a completeness the scan did not reach — green dishonesty in place of amber.
  it.each(['entry-limit', 'candidate-limit'] as const)(
    'does not report all-clear when %s ended the scan early',
    async (reason) => {
      mocks.inventory = {
        schemaVersion: 1,
        installations: [
          placement('orca-cli', { status: 'current', observedPackageDigest: 'current' })
        ],
        eligibleUpdateNames: [],
        scanIssues: [
          {
            rootId: 'codex-plugin-cache',
            sourceLabel: 'Codex plugin cache',
            path: '/home/.codex/plugins/cache',
            reason: reason,
            errorCode: null
          }
        ],
        scannedAt: 2
      }
      await renderDialog()
      await openViaRequest()

      expect(container?.textContent).not.toContain('All installed Orca skills are up to date.')
      expect(container?.textContent).toContain(
        'Orca could not finish checking plugin-managed skills.'
      )
      // Why: the headline alone would pass with the folder list gone, leaving the user
      // told the scan stopped but never told where. Assert the diagnostic renders too.
      expect(container?.textContent).toContain('/home/.codex/plugins/cache')
    }
  )

  // Why: Orca's own traversal bounds are not the user's to act on. Headlining them
  // would put a permanent warning on any ordinary large plugin cache while every
  // skill badge stayed green — the same unclearable amber, moved into the dialog.
  it('lists a traversal bound without headlining it', async () => {
    mocks.inventory = {
      schemaVersion: 1,
      installations: [
        placement('orca-cli', { status: 'current', observedPackageDigest: 'current' })
      ],
      eligibleUpdateNames: [],
      scanIssues: [
        {
          rootId: 'codex-plugin-cache',
          sourceLabel: 'Codex plugin cache',
          path: '/home/.codex/plugins/cache/vendor/deep',
          reason: 'depth-limit',
          errorCode: null
        }
      ],
      scannedAt: 2
    }
    await renderDialog()
    await openViaRequest()

    expect(container?.textContent).toContain('All installed Orca skills are up to date.')
    expect(container?.textContent).not.toContain(
      'Orca could not finish checking plugin-managed skills.'
    )
    expect(container?.textContent).toContain('/home/.codex/plugins/cache/vendor/deep')
    expect(container?.textContent).toContain('scan depth limit')
  })
})
