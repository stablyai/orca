// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillUpdateRun } from '../../../../shared/skill-freshness'
import { SkillUpdateStatusSegment } from './SkillUpdateStatusSegment'
import {
  _resetSkillUpdateRunStore,
  SKILL_UPDATE_SUCCESS_LINGER_MS
} from '../skills/skill-update-run-store'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  getSkillFreshnessUpdateDialogRequest
} from '../skills/skill-freshness-update-dialog'

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <div data-tooltip>{children}</div>
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

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<SkillUpdateStatusSegment iconOnly={false} />)
  })
}

async function emitRun(run: SkillUpdateRun): Promise<void> {
  await act(async () => {
    pushRun?.(run)
  })
}

describe('SkillUpdateStatusSegment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetSkillUpdateRunStore()
    consumeSkillFreshnessUpdateDialogRequest()
    pushRun = null
    skillsApi.acknowledgeUpdateRun.mockClear()
    ;(window as unknown as { api: { skills: typeof skillsApi } }).api = { skills: skillsApi }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
    vi.useRealTimers()
  })

  it('renders nothing while idle', async () => {
    await render()
    expect(container?.querySelector('button')).toBeNull()
  })

  it('shows a spinner and skill count while the run is in flight', async () => {
    await render()
    await emitRun({
      state: 'running',
      names: ['orca-cli', 'orchestration'],
      startedAt: 1,
      output: ''
    })

    expect(container?.textContent).toContain('Updating skills')
    expect(container?.querySelector('.animate-spin')).not.toBeNull()
    expect(container?.textContent).toContain('Updating 2 skills…')
  })

  it('shows a green check on success, then retires itself', async () => {
    await render()
    await emitRun({ state: 'success', names: ['orca-cli'], finishedAt: 2, output: '' })

    expect(container?.textContent).toContain('Skills updated')
    expect(container?.querySelector('.text-emerald-500')).not.toBeNull()
    expect(skillsApi.acknowledgeUpdateRun).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(SKILL_UPDATE_SUCCESS_LINGER_MS)
    })
    // The linger elapsing asks main to clear the run; main echoes idle back.
    expect(skillsApi.acknowledgeUpdateRun).toHaveBeenCalledTimes(1)
    await emitRun({ state: 'idle' })
    expect(container?.querySelector('button')).toBeNull()
  })

  it('keeps a failure visible instead of auto-clearing it', async () => {
    await render()
    await emitRun({
      state: 'error',
      names: ['orca-cli'],
      failedNames: ['orca-cli'],
      finishedAt: 3,
      output: '',
      message: 'exited with code 1'
    })

    await act(async () => {
      vi.advanceTimersByTime(SKILL_UPDATE_SUCCESS_LINGER_MS * 3)
    })
    expect(container?.textContent).toContain('Update failed')
    expect(skillsApi.acknowledgeUpdateRun).not.toHaveBeenCalled()
  })

  it('reopens the update dialog when clicked', async () => {
    await render()
    await emitRun({ state: 'running', names: ['orca-cli'], startedAt: 1, output: '' })
    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(getSkillFreshnessUpdateDialogRequest()).toBe(true)
  })
})
