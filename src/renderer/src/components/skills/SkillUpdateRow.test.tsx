// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillFreshnessGroupModel } from './skill-freshness-grouping'
import { SkillUpdateRow } from './SkillUpdateRow'

// Why: render tooltip content inline so the copy it carries can be asserted.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => (
    <div data-tooltip-content>{children}</div>
  )
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function group(overrides: Partial<SkillFreshnessGroupModel> = {}): SkillFreshnessGroupModel {
  return {
    name: 'computer-use',
    status: 'update-available',
    orcaOwned: false,
    lockSource: 'acme/agent-skills',
    locations: [
      {
        id: 'location',
        path: '/home/.agents/skills/computer-use',
        chip: null,
        participatesInGlobalFreshness: true
      }
    ],
    ...overrides
  }
}

async function render(element: React.JSX.Element): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(element)
  })
}

function tooltipText(): string | undefined {
  return container?.querySelector('[data-tooltip-content]')?.textContent ?? undefined
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
})

describe('SkillUpdateRow', () => {
  it('labels a copy from another source quietly and names that source', async () => {
    await render(<SkillUpdateRow group={group()} state="available" />)

    expect(container?.textContent).toContain('Not from Orca')
    expect(container?.textContent).not.toContain('Update available')
    expect(tooltipText()).toBe(
      'Installed from acme/agent-skills. Selecting it replaces it with Orca’s version.'
    )
    // Why: the source is only in the tooltip, so keyboard focus must be able to open it.
    const label = Array.from(container?.querySelectorAll('[tabindex="0"]') ?? []).find((node) =>
      node.textContent?.includes('Not from Orca')
    )
    expect(label).toBeDefined()
  })

  it('says there is no install record when the lock has no entry', async () => {
    await render(<SkillUpdateRow group={group({ lockSource: null })} state="available" />)

    expect(tooltipText()).toBe(
      'No Orca install record for this copy. Selecting it replaces it with Orca’s version.'
    )
  })

  it('keeps the update badge for Orca’s own skill', async () => {
    await render(
      <SkillUpdateRow
        group={group({ name: 'orca-cli', orcaOwned: true, lockSource: 'stablyai/orca' })}
        state="available"
      />
    )

    expect(container?.textContent).toContain('Update available')
    expect(container?.textContent).not.toContain('Not from Orca')
  })

  it('renders a checkbox only while the user is choosing', async () => {
    const onCheckedChange = vi.fn()
    await render(
      <SkillUpdateRow
        group={group()}
        state="available"
        selection={{ checked: false, onCheckedChange }}
      />
    )
    const checkbox = container?.querySelector('[role="checkbox"]')
    expect(checkbox?.getAttribute('aria-label')).toBe('Include computer-use')
    await act(async () => {
      checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCheckedChange).toHaveBeenCalledWith(true)

    await act(async () => {
      root?.render(<SkillUpdateRow group={group()} state="pending" />)
    })
    expect(container?.querySelector('[role="checkbox"]')).toBeNull()
  })
})
