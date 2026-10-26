// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { BrowserUseSkillStep } from './BrowserUseSkillStep'

const mocks = vi.hoisted(() => ({ plan: vi.fn() }))
const TARGET = { kind: 'environment', environmentId: 'agents-host' } as const
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: TARGET })
}))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: vi.fn()
}))
afterEach(cleanup)

it.each([false, true])(
  'marks the Browser step complete only when its plan is current (blocked: %s)',
  async (blocked) => {
    mocks.plan.mockResolvedValue({
      kind: 'plan',
      plan: planOf([
        sharedEntry('orca-cli', blocked ? 'leave' : 'keep', blocked ? { reason: 'unwritable' } : {})
      ])
    })
    const { container } = render(
      <BrowserUseSkillStep
        skillDetected
        skillLoading={false}
        skillError={null}
        onRecheck={vi.fn()}
      />
    )
    expect(await screen.findByText(blocked ? 'Needs attention' : 'Up to date')).toBeDefined()
    expect(Boolean(container.querySelector('svg.lucide-check'))).toBe(!blocked)
  }
)
