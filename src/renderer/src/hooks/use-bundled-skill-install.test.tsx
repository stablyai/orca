// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillInstallResult } from '../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import {
  doneResult,
  planOf,
  sharedEntry
} from '@/components/skills/bundled-skill-plan-fixtures.test-support'
import { useBundledSkillInstall, type BundledSkillInstall } from './use-bundled-skill-install'

const mocks = vi.hoisted(() => {
  const localTarget = (): BundledSkillTarget | null => ({ kind: 'local' })
  return { plan: vi.fn(), execute: vi.fn(), target: localTarget() }
})

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))

vi.mock('./useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: mocks.target })
}))

vi.mock('./installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
}))

const PLAN = planOf([sharedEntry('orca-cli', 'write')])

let root: Root | null = null
let latest: BundledSkillInstall | null = null

function Harness(): null {
  latest = useBundledSkillInstall()
  return null
}

async function renderHarness(): Promise<BundledSkillInstall> {
  root = createRoot(document.createElement('div'))
  await act(async () => {
    root?.render(<Harness />)
  })
  if (!latest) {
    throw new Error('hook did not render')
  }
  return latest
}

describe('useBundledSkillInstall', () => {
  beforeEach(() => {
    mocks.plan.mockReset()
    mocks.plan.mockResolvedValue({ kind: 'plan', plan: PLAN })
    mocks.execute.mockReset()
    mocks.execute.mockResolvedValue(doneResult(PLAN))
    mocks.target = { kind: 'local' }
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    latest = null
  })

  it('installs on a newly focused host while the previous one is still installing', async () => {
    let finishFirst: (() => void) | null = null
    mocks.execute.mockReturnValueOnce(
      new Promise<BundledSkillInstallResult>((resolve) => {
        finishFirst = () => resolve(doneResult(PLAN))
      })
    )
    const hook = await renderHarness()
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = hook.install(['orca-cli'])
    })
    expect(latest?.state.kind).toBe('installing')

    mocks.target = { kind: 'environment', environmentId: 'env-2' }
    await act(async () => {
      root?.render(<Harness />)
    })
    expect(latest?.state.kind).toBe('idle')

    await act(async () => {
      await latest?.install(['orca-cli'])
    })
    expect(mocks.execute).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'env-2' },
      PLAN.planDigest,
      { names: ['orca-cli'] }
    )
    expect(latest?.state.kind).toBe('done')

    await act(async () => {
      finishFirst?.()
      await first
    })
    // Why: the first host's late result lands in its own slot, not the focused host's.
    expect(latest?.state).toMatchObject({ kind: 'done' })
    mocks.target = { kind: 'local' }
    await act(async () => {
      root?.render(<Harness />)
    })
    expect(latest?.state.kind).toBe('done')
  })

  it('ignores a repeated click while the install runs', async () => {
    mocks.plan.mockReturnValueOnce(new Promise(() => {}))
    const hook = await renderHarness()
    await act(async () => {
      void hook.install(['orca-cli'])
    })

    let repeat: Awaited<ReturnType<BundledSkillInstall['install']>> = { kind: 'idle' }
    await act(async () => {
      repeat = (await latest?.install(['orca-cli'])) ?? null
    })

    expect(repeat).toBeNull()
    expect(mocks.plan).toHaveBeenCalledOnce()
    expect(latest?.state.kind).toBe('installing')
  })

  it('retries the last requested skills on this host', async () => {
    mocks.plan.mockRejectedValueOnce(new Error('skill-install-home-unavailable'))
    const hook = await renderHarness()

    await act(async () => {
      await hook.install(['orca-cli', 'orchestration'])
    })
    expect(latest?.state.kind).toBe('failed')

    await act(async () => {
      latest?.retry()
    })

    expect(mocks.plan).toHaveBeenLastCalledWith(
      { kind: 'local' },
      { names: ['orca-cli', 'orchestration'] }
    )
    expect(latest?.state.kind).toBe('done')
  })
})
