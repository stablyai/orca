// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentLocation, sharedLocation } from '@/lib/bundled-skill-plan-fixtures'
import type { SkillFreshnessGroupModel } from './skill-freshness-grouping'
import { SkillUpdateRow } from './SkillUpdateRow'

// Why: Radix unmounts closed disclosure content; render it so location chips can be asserted.
vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function group(overrides: Partial<SkillFreshnessGroupModel> = {}): SkillFreshnessGroupModel {
  return {
    name: 'computer-use',
    status: 'update-available',
    locations: [sharedLocation('computer-use', 'update'), agentLocation('computer-use', 'keep')],
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

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
})

describe('SkillUpdateRow', () => {
  it('shows what the install does to each location', async () => {
    await render(<SkillUpdateRow group={group()} state="available" />)

    expect(container?.textContent).toContain('Update available')
    expect(container?.textContent).toContain('Will update')
    expect(container?.textContent).toContain('No change')
  })

  it('says why a location is left as it is, beside an update too', async () => {
    await render(
      <SkillUpdateRow
        group={group({
          locations: [
            sharedLocation('computer-use', 'update'),
            agentLocation('computer-use', 'leave', 'local-changes')
          ]
        })}
        state="available"
      />
    )

    expect(container?.textContent).toContain('Local changes')
    expect(container?.textContent).toContain(
      'This copy has changes Orca didn’t make, so the update leaves it as it is.'
    )
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
