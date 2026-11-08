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
import { doneResult, planOf, sharedEntry } from './bundled-skill-plan-fixtures.test-support'

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
})
