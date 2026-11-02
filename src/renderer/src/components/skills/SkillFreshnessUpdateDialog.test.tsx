// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BundledSkillInstallResult,
  BundledSkillExecuteRequest,
  BundledSkillPlanRequest,
  BundledSkillPlan
} from '../../../../shared/bundled-skill-plan'
import { SkillFreshnessUpdateDialog } from './SkillFreshnessUpdateDialog'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  requestSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'
import { _resetSkillUpdateRunStore, getSkillUpdateRun } from './skill-update-run-store'

const LOCAL_SKILL_UPDATE_TARGET = 'local'
import {
  doneResult,
  planEntry,
  planOf,
  planOp,
  sharedEntry
} from './bundled-skill-plan-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  plan: ((): BundledSkillPlan | null => null)(),
  unsupported: ((): string | null => null)(),
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  notifyChanged: vi.fn()
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    plan: mocks.plan,
    unsupported: mocks.unsupported,
    loading: mocks.loading,
    error: mocks.error,
    refresh: mocks.refresh
  })
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: { kind: 'local' } })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notifyChanged
}))

// Stub Radix to test dialog content here; Electron QA covers its internals.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-dialog-open="true">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const skillsApi = {
  bundledPlan: vi.fn(async (_request?: BundledSkillPlanRequest): Promise<BundledSkillPlan> =>
    planOf([])
  ),
  bundledExecute: vi.fn(
    async (_request: BundledSkillExecuteRequest): Promise<BundledSkillInstallResult> => ({
      scope: 'global',
      skills: []
    })
  )
}

const EDITED_PATH = '/home/u/.claude/skills/orca-cli'

function editedPlan(): BundledSkillPlan {
  return planOf(
    [
      planEntry('orca-cli', [
        planOp('update', '/home/u/.agents/skills/orca-cli'),
        planOp('leave', EDITED_PATH, { reason: 'edited', replaceable: true })
      ])
    ],
    '1'.repeat(64)
  )
}

function forcedPlan(): BundledSkillPlan {
  return planOf(
    [
      planEntry('orca-cli', [
        planOp('update', '/home/u/.agents/skills/orca-cli'),
        planOp('replace', EDITED_PATH, { content: 'link' })
      ])
    ],
    '2'.repeat(64)
  )
}

let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<SkillFreshnessUpdateDialog />)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!found) {
    throw new Error(`No button "${label}" in: ${container.textContent}`)
  }
  return found
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function replaceCheckbox(): HTMLElement {
  const label = [...container.querySelectorAll('label')].find((candidate) =>
    candidate.textContent?.includes('Replace')
  )
  const checkbox = label?.querySelector('[role="checkbox"]')
  if (!(checkbox instanceof HTMLElement)) {
    throw new Error('No Replace toggle')
  }
  return checkbox
}

beforeEach(() => {
  mocks.plan = null
  mocks.unsupported = null
  mocks.loading = false
  mocks.error = null
  mocks.refresh.mockReset()
  mocks.notifyChanged.mockReset()
  skillsApi.bundledPlan.mockReset()
  skillsApi.bundledExecute.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { skills: skillsApi }
  })
  _resetSkillUpdateRunStore()
  consumeSkillFreshnessUpdateDialogRequest()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  requestSkillFreshnessUpdateDialog()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  consumeSkillFreshnessUpdateDialogRequest()
  _resetSkillUpdateRunStore()
})

describe('SkillFreshnessUpdateDialog', () => {
  it('lists only skills with something to do, and every location on request', () => {
    mocks.plan = planOf([
      planEntry('orca-cli', [
        planOp('update', '/home/u/.agents/skills/orca-cli'),
        planOp('keep', '/home/u/.claude/skills/orca-cli', {
          observed: { kind: 'link', target: '../../.agents/skills/orca-cli' }
        })
      ]),
      sharedEntry('orchestration', 'keep'),
      sharedEntry('orca-linear', 'keep')
    ])
    render()

    expect(container.textContent).toContain('1 update available')
    expect(container.querySelector('[data-skill-row="orca-cli"]')?.textContent).toBe(
      'orca-cliUpdate available'
    )
    expect(container.querySelector('[data-skill-row="orchestration"]')).toBeNull()
    expect(container.textContent).toContain('2 skills are up to date.')
    expect(button('Update 1 skill').disabled).toBe(false)

    click(button('Show folders'))
    const row = container.querySelector('[data-skill-row="orca-cli"]')?.textContent ?? ''
    expect(row).toContain('Shared folder · ~/.agents/skills/orca-cli')
    expect(row).toContain('Claude Code · ~/.claude/skills/orca-cli')
    expect(container.querySelector('[data-skill-row="orchestration"]')).not.toBeNull()
    click(button('Hide folders'))
    expect(container.textContent).not.toContain('~/.agents/skills/orca-cli')
  })

  it.each([
    ['update-server', 'Update Orca on the server to update its Orca skills.'],
    ['connect-host', 'Connect to this SSH host to check its Orca skills.']
  ])('explains a %s host instead of offering Update', (reason, text) => {
    mocks.unsupported = reason
    render()

    expect(container.textContent).toContain(text)
    expect(container.textContent).not.toMatch(/Update \d+ skills?/)
  })

  it('labels a link-only plan as installing for the agent, not an update', () => {
    mocks.plan = planOf([
      planEntry('orca-cli', [
        planOp('keep', '/home/u/.agents/skills/orca-cli'),
        planOp('link', '/home/u/.claude/skills/orca-cli')
      ])
    ])
    render()

    expect(container.textContent).toContain('All installed Orca skills are up to date.')
    expect(button('Install for Claude Code').disabled).toBe(false)
  })

  it('names a copy left alone by its agent, with its Replace choice', () => {
    mocks.plan = editedPlan()
    render()

    const row = container.querySelector('[data-skill-row="orca-cli"]')
    expect(row?.textContent).toContain('Update skipped: Skill edited outside Orca')
    expect(row?.textContent).toContain("Replace with Orca's copy (keeps a backup)")
  })

  it('re-plans with force when Replace is toggled and executes that plan', async () => {
    mocks.plan = editedPlan()
    const forced = deferred<BundledSkillPlan>()
    skillsApi.bundledPlan.mockReturnValueOnce(forced.promise)
    render()

    click(replaceCheckbox())
    expect(skillsApi.bundledPlan).toHaveBeenCalledWith({ force: [EDITED_PATH] })
    // Why: the forced plan has not landed, so Update must not run the unforced one.
    expect(button('Update 1 skill').disabled).toBe(true)

    await act(async () => {
      forced.resolve(forcedPlan())
      await forced.promise
    })
    expect(container.querySelector('[data-skill-row="orca-cli"]')?.textContent).toBe(
      "orca-cliReplaceReplace with Orca's copy (keeps a backup)"
    )
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(forcedPlan()))
    click(button('Update 1 skill'))
    await flush()

    expect(skillsApi.bundledExecute).toHaveBeenCalledWith({
      planDigest: '2'.repeat(64),
      request: { force: [EDITED_PATH] }
    })
    expect(container.querySelector('[data-skill-row="orca-cli"]')?.textContent).toBe(
      'orca-cliReplaced · Your copy was saved as a backup'
    )
  })

  it('keeps an edited row in place with one Replace status when selected', async () => {
    mocks.plan = planOf([
      planEntry('orca-cli', [
        planOp('leave', EDITED_PATH, { reason: 'edited', replaceable: true })
      ]),
      sharedEntry('orchestration', 'update')
    ])
    skillsApi.bundledPlan.mockResolvedValueOnce(
      planOf([
        planEntry('orca-cli', [planOp('replace', EDITED_PATH)]),
        sharedEntry('orchestration', 'update')
      ])
    )
    render()
    const rowNames = () =>
      [...container.querySelectorAll('[data-skill-row]')].map((row) =>
        row.getAttribute('data-skill-row')
      )
    expect(rowNames()).toEqual(['orchestration', 'orca-cli'])

    click(replaceCheckbox())
    await flush()

    expect(rowNames()).toEqual(['orchestration', 'orca-cli'])
    const row = container.querySelector('[data-skill-row="orca-cli"]')
    expect(row?.textContent).toBe("orca-cliReplaceReplace with Orca's copy (keeps a backup)")
    expect(replaceCheckbox().getAttribute('aria-checked')).toBe('true')

    click(replaceCheckbox())
    await flush()
    expect(rowNames()).toEqual(['orchestration', 'orca-cli'])
    expect(row?.textContent).toContain('Update skipped: Skill edited outside Orca')
  })

  it('reports each skill with its left-alone copies after the run', async () => {
    const plan = editedPlan()
    mocks.plan = plan
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(plan))
    render()

    click(button('Update 1 skill'))
    await flush()

    expect(skillsApi.bundledExecute).toHaveBeenCalledWith({
      planDigest: plan.planDigest,
      request: { force: [] }
    })
    expect(container.textContent).toContain('Updated 1 skill · 1 skipped')
    const row = container.querySelector('[data-skill-row="orca-cli"]')?.textContent ?? ''
    expect(row).toContain('Updated')
    expect(row).toContain('Update skipped: Skill edited outside Orca')
    expect(mocks.notifyChanged).toHaveBeenCalled()
    expect(button('Done')).toBeTruthy()
  })

  it.each([false, true])('keeps Update available after recovery (mixed run: %s)', async (mixed) => {
    const repair = planOf([
      sharedEntry('orca-cli', 'restore'),
      ...(mixed ? [sharedEntry('orchestration', 'update')] : [])
    ])
    const update = planOf([sharedEntry('orca-cli', 'update')], '3'.repeat(64))
    mocks.plan = repair
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(repair))
    render()

    click(button(mixed ? 'Update 2 skills' : 'Update 1 skill'))
    await flush()

    expect(container.textContent).not.toContain(mixed ? 'Updated 1 skill' : 'Updated 0 skills')
    expect(container.querySelector('.text-status-success')).toBeNull()
    expect(container.querySelector('.lucide-triangle-alert')?.parentElement?.textContent).toBe(
      'Needs attention'
    )
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET)).toMatchObject({
      state: 'done',
      summary: { ok: true, exitCode: 0, changedCount: mixed ? 1 : 0 }
    })

    mocks.plan = null
    render()
    expect(button(mixed ? 'Update 2 skills' : 'Update 1 skill').disabled).toBe(true)

    mocks.plan = update
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(update))
    render()
    expect(button('Update 1 skill').disabled).toBe(false)
    click(button('Update 1 skill'))
    await flush()

    expect(skillsApi.bundledExecute).toHaveBeenLastCalledWith({
      planDigest: update.planDigest,
      request: { force: [] }
    })
    expect(container.textContent).toContain('Updated 1 skill')
    expect(button('Done')).toBeTruthy()
  })

  it('counts skills rather than folders in the preview and result headlines', async () => {
    const plan = planOf([
      planEntry('orca-cli', [
        planOp('update', '/home/u/.agents/skills/orca-cli'),
        planOp('update', EDITED_PATH)
      ]),
      sharedEntry('orchestration', 'update'),
      planEntry('computer-use', [
        planOp('leave', '/home/u/.agents/skills/computer-use', { reason: 'edited' }),
        planOp('leave', '/home/u/.claude/skills/computer-use', { reason: 'shared-not-current' }),
        planOp('leave', '/home/u/.cursor/skills/computer-use', { reason: 'shared-not-current' })
      ])
    ])
    mocks.plan = plan
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(plan))
    render()

    expect(container.textContent).toContain('2 updates available')
    click(button('Update 2 skills'))
    await flush()

    expect(container.textContent).toContain('Updated 2 skills · 1 skipped')
  })

  it('keeps preview row order through a replacement run and the refreshed plan', async () => {
    const replacementPath = '/home/u/.claude/skills/computer-use'
    mocks.plan = planOf([
      planEntry('computer-use', [
        planOp('leave', replacementPath, { reason: 'edited', replaceable: true })
      ]),
      sharedEntry('orca-cli', 'update'),
      sharedEntry('agent-discord', 'leave', { reason: 'unwritable' }),
      sharedEntry('orchestration', 'restore')
    ])
    const forced = planOf(
      mocks.plan.skills.map((entry) =>
        entry.name === 'computer-use'
          ? planEntry(entry.name, [planOp('replace', replacementPath)])
          : entry
      ),
      '2'.repeat(64)
    )
    skillsApi.bundledPlan.mockResolvedValueOnce(forced)
    const execution = deferred<BundledSkillInstallResult>()
    skillsApi.bundledExecute.mockReturnValueOnce(execution.promise)
    const rowNames = () =>
      [...container.querySelectorAll('[data-skill-row]')].map((row) =>
        row.getAttribute('data-skill-row')
      )
    const previewOrder = ['orchestration', 'orca-cli', 'computer-use', 'agent-discord']
    render()
    expect(rowNames()).toEqual(previewOrder)
    click(replaceCheckbox())
    await flush()
    expect(rowNames()).toEqual(previewOrder)

    click(button('Update 3 skills'))
    expect(rowNames()).toEqual(previewOrder)
    await act(async () => {
      execution.resolve(doneResult(forced))
      await execution.promise
    })
    expect(rowNames()).toEqual(previewOrder)

    mocks.plan = null
    render()
    expect(rowNames()).toEqual(previewOrder)
    mocks.plan = planOf([
      sharedEntry('computer-use', 'keep'),
      sharedEntry('orca-cli', 'keep'),
      sharedEntry('agent-discord', 'leave', { reason: 'unwritable' }),
      sharedEntry('orchestration', 'keep')
    ])
    skillsApi.bundledPlan.mockResolvedValueOnce(mocks.plan)
    render()
    await flush()
    expect(rowNames()).toEqual(previewOrder)
  })

  it('reports a location that changed since review as needing attention', async () => {
    const plan = planOf([sharedEntry('orca-cli', 'update')])
    mocks.plan = plan
    skillsApi.bundledExecute.mockResolvedValueOnce({
      scope: 'global',
      skills: [{ name: 'orca-cli', status: 'changed', ops: [] }]
    })
    render()

    click(button('Update 1 skill'))
    await flush()

    expect(container.textContent).toContain('Some skills need attention')
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET)).toMatchObject({
      state: 'done',
      summary: { ok: false, exitCode: 1 }
    })
  })

  it('drops a completion for a run that was reset while it was in flight', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    const execution = deferred<BundledSkillInstallResult>()
    skillsApi.bundledExecute.mockReturnValueOnce(execution.promise)
    render()

    click(button('Update 1 skill'))
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET).state).toBe('running')
    _resetSkillUpdateRunStore()

    await act(async () => {
      execution.resolve(doneResult(planOf([sharedEntry('orca-cli', 'update')])))
      await execution.promise
    })
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET).state).toBe('idle')
    expect(mocks.notifyChanged).not.toHaveBeenCalled()
  })

  it('shows the error when the request itself fails', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    skillsApi.bundledExecute.mockRejectedValueOnce(new Error('ipc closed'))
    render()

    click(button('Update 1 skill'))
    await flush()

    expect(container.textContent).toContain("The update didn't finish")
    expect(container.textContent).toContain('ipc closed')
  })

  it('acknowledges a finished run on close', async () => {
    const plan = planOf([sharedEntry('orca-cli', 'update')])
    mocks.plan = plan
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(plan))
    render()
    click(button('Update 1 skill'))
    await flush()

    click(button('Done'))
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET).state).toBe('idle')
    expect(container.querySelector('[data-dialog-open]')).toBeNull()
  })

  it.each(['edited', 'other'] as const)(
    'shows no available updates when only %s copies remain',
    (reason) => {
      mocks.plan = planOf([
        planEntry('orca-cli', [planOp('leave', EDITED_PATH, { reason, replaceable: true })])
      ])
      render()
      expect(container.textContent).toContain('No updates available')
      const headline = [...container.querySelectorAll('div')].find(
        (element) => element.textContent === 'No updates available'
      )
      expect(headline?.querySelector('svg')).toBeNull()
      expect(container.textContent).not.toContain('left alone')
    }
  )

  it.each([1, 2])(
    'counts %i current skills beside skipped copies without repeating a footer',
    (count) => {
      mocks.plan = planOf([
        planEntry('orca-cli', [planOp('leave', EDITED_PATH, { reason: 'edited' })]),
        ...['orchestration', 'orca-linear'].slice(0, count).map((name) => sharedEntry(name, 'keep'))
      ])
      render()

      const headline = `${count} ${count === 1 ? 'skill is' : 'skills are'} up to date`
      expect(container.textContent?.split(headline)).toHaveLength(2)
      expect(container.textContent).not.toContain(`${headline}.`)
      expect(container.querySelector('.lucide-circle-check')).not.toBeNull()
      expect(container.querySelector('.lucide-triangle-alert')).toBeNull()
      click(button('Show folders'))
      expect(container.textContent?.split(headline)).toHaveLength(2)
    }
  )

  it('offers no Update when nothing would change', () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'keep')])
    render()

    expect(container.textContent).toContain('All installed Orca skills are up to date.')
    expect(
      [...container.querySelectorAll('button')].some((candidate) =>
        candidate.textContent?.startsWith('Update ')
      )
    ).toBe(false)
  })
})
