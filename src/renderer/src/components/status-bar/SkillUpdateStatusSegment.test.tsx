// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillInstallResult } from '../../../../shared/bundled-skill-plan'
import { SkillUpdateStatusSegment } from './SkillUpdateStatusSegment'
import {
  _resetSkillUpdateRunStore,
  SKILL_UPDATE_SUCCESS_LINGER_MS,
  startSkillUpdateRun
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

let settle: ((result: BundledSkillInstallResult) => void) | null = null
const skillsApi = {
  bundledExecute: vi.fn(
    () =>
      new Promise<BundledSkillInstallResult>((resolve) => {
        settle = resolve
      })
  )
}

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

let running: Promise<void> | null = null

async function start(names: string[]): Promise<void> {
  await act(async () => {
    running = startSkillUpdateRun({
      target: { kind: 'local' },
      names,
      planDigest: 'a'.repeat(64),
      force: []
    })
  })
}

async function finish(result: BundledSkillInstallResult): Promise<void> {
  await act(async () => {
    settle?.(result)
    await running
  })
}

function ran(status: 'done' | 'failed', name = 'orca-cli'): BundledSkillInstallResult {
  return {
    scope: 'global',
    skills: [
      {
        name,
        status: 'ran',
        ops: [{ path: `/home/u/.agents/skills/${name}`, kind: 'update', status }]
      }
    ]
  }
}

describe('SkillUpdateStatusSegment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetSkillUpdateRunStore()
    consumeSkillFreshnessUpdateDialogRequest()
    settle = null
    running = null
    skillsApi.bundledExecute.mockClear()
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
    await start(['orca-cli', 'orchestration'])

    expect(container?.textContent).toContain('Updating skills')
    expect(container?.querySelector('.animate-spin')).not.toBeNull()
    expect(container?.textContent).toContain('Updating 2 skills…')
  })

  it('shows a green check on success, then retires itself', async () => {
    await render()
    await start(['orca-cli'])
    await finish(ran('done'))

    expect(container?.textContent).toContain('Skills updated')
    expect(container?.querySelector('.text-emerald-500')).not.toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(SKILL_UPDATE_SUCCESS_LINGER_MS)
    })
    expect(container?.querySelector('button')).toBeNull()
  })

  it.each([1, 2, 3])('counts completed updates with %i skipped skills', async (skippedCount) => {
    await render()
    const names = ['orca-cli', 'orchestration', 'orca-linear', 'computer-use'].slice(
      0,
      skippedCount + 1
    )
    await start(names)
    expect(container?.querySelector('[data-tooltip]')?.textContent).toBe(
      `Updating ${names.length} skills…`
    )
    const skills = [...ran('done', names[1]).skills]
    skills.unshift({
      name: names[0],
      status: 'ran',
      ops: [
        {
          path: `/home/u/.claude/skills/${names[0]}`,
          kind: 'leave',
          status: 'done',
          reason: 'edited'
        }
      ]
    })
    for (const name of names.slice(2)) {
      skills.push({
        ...skills[0],
        name,
        ops: [{ ...skills[0].ops[0], path: `/home/u/.claude/skills/${name}` }]
      })
    }
    await finish({ scope: 'global', skills })

    expect(container?.textContent).toContain('Skills updated')
    expect(container?.querySelector('[data-tooltip]')?.textContent).toBe(
      `Updated 1 skill · ${skippedCount} skipped`
    )
  })

  it('counts completed updates when every requested skill changed', async () => {
    await render()
    await start(['orca-cli', 'orchestration'])
    await finish({
      scope: 'global',
      skills: [...ran('done').skills, ...ran('done', 'orchestration').skills]
    })

    expect(container?.querySelector('[data-tooltip]')?.textContent).toBe('Updated 2 skills')
  })

  it('keeps a run with problems visible instead of auto-clearing it', async () => {
    await render()
    await start(['orca-cli'])
    await finish(ran('failed'))

    await act(async () => {
      vi.advanceTimersByTime(SKILL_UPDATE_SUCCESS_LINGER_MS * 3)
    })
    expect(container?.textContent).toContain('Skills need attention')
    expect(container?.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Some skill updates were skipped. Click to open details.'
    )
    expect(container?.textContent).toContain(
      'Some skill updates were skipped — click to see details'
    )
  })

  it.each([false, true])(
    'keeps recovery needing attention visible (mixed run: %s)',
    async (mixed) => {
      await render()
      await start(mixed ? ['orca-cli', 'orchestration'] : ['orca-cli'])
      const skills = [...ran('done').skills]
      skills[0].ops[0].kind = 'restore'
      if (mixed) {
        skills.push(ran('done', 'orchestration').skills[0])
      }
      await finish({ scope: 'global', skills })

      expect(container?.textContent).toContain('Needs attention')
      expect(container?.textContent).not.toContain('Skills updated')
      expect(container?.querySelector('.text-emerald-500')).toBeNull()
      await act(async () => {
        vi.advanceTimersByTime(SKILL_UPDATE_SUCCESS_LINGER_MS * 3)
      })
      expect(container?.querySelector('button')).not.toBeNull()
    }
  )

  it('reopens the update dialog when clicked', async () => {
    await render()
    await start(['orca-cli'])
    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(getSkillFreshnessUpdateDialogRequest()).toBe(true)
  })
})
