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
import { consumeSkillFreshnessUpdateDialogRequest } from '../skills/skill-freshness-update-dialog'

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
})
