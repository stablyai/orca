// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import RepoMultiCombobox from './repo-multi-combobox'

// Shallow popover/command mocks (same pattern as the groups render test) so the
// trigger button — and its summary label — render synchronously in jsdom.
import { vi } from 'vitest'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-command-value={value}>{children}</div>
  )
}))

function repo(id: string, displayName: string): Repo {
  return { id, displayName, path: `/repos/${id}`, badgeColor: '#111111', addedAt: 1 }
}

const repos = [
  repo('r1', 'identity-gateway-dashboard'),
  repo('r2', 'identity-gateway-web'),
  repo('r3', 'identity-gateway-api'),
  repo('r4', 'identity-gateway-docs'),
  repo('r5', 'identity-gateway-mobile')
]

let container: HTMLDivElement
let root: Root

function renderTrigger(selected: ReadonlySet<string>): HTMLElement {
  act(() => {
    root.render(
      <RepoMultiCombobox
        repos={repos}
        selected={selected}
        onChange={() => {}}
        onSelectAll={() => {}}
      />
    )
  })
  const trigger = container.querySelector<HTMLElement>('[role="combobox"]')
  if (!trigger) {
    throw new Error('trigger not found')
  }
  return trigger
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('RepoMultiCombobox trigger label', () => {
  it('summarizes a multi-selection as the first repo plus a +N count, not every name', () => {
    const trigger = renderTrigger(new Set(['r1', 'r2', 'r3']))
    // Only the first selected repo name is shown inline...
    expect(trigger.textContent).toContain('identity-gateway-dashboard')
    // ...the rest collapse into a fixed count so long names can't overflow.
    expect(trigger.textContent).toContain('+2')
    expect(trigger.textContent).not.toContain('identity-gateway-web')
    expect(trigger.textContent).not.toContain('identity-gateway-api')
  })

  it('shows a single selected repo without a count', () => {
    const trigger = renderTrigger(new Set(['r1']))
    expect(trigger.textContent).toContain('identity-gateway-dashboard')
    expect(trigger.textContent).not.toContain('+')
  })

  it('collapses a full selection to "All projects"', () => {
    const trigger = renderTrigger(new Set(repos.map((r) => r.id)))
    expect(trigger.textContent).toContain('All projects')
    expect(trigger.textContent).not.toContain('+')
  })

  it('keeps the label shrinkable and the chevron fixed so the row cannot be pushed', () => {
    const trigger = renderTrigger(new Set(['r1', 'r2', 'r3', 'r4']))
    // The summary wrapper takes the flexible space and can shrink (min-w-0),
    // and the trailing count is pinned so it never disappears.
    const summary = trigger.querySelector('span.flex-1')
    expect(summary?.className).toContain('min-w-0')
    expect(summary?.textContent).toContain('+3')
    expect(trigger.querySelector('.shrink-0')).not.toBeNull()
  })
})
