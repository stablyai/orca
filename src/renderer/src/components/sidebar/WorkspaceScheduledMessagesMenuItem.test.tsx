// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { WorkspaceScheduledMessagesMenuItem } from './WorkspaceScheduledMessagesMenuItem'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))

afterEach(cleanup)

describe('WorkspaceScheduledMessagesMenuItem', () => {
  it('keeps the pending count out of the label so the w-52 menu row stays one line', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <WorkspaceScheduledMessagesMenuItem
            pendingCount={2}
            disabled={false}
            onSelect={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const item = screen.getByRole('menuitem', { name: 'Schedule message… (2 pending)' })

    expect(item.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe('2')
    expect(item.textContent).toBe('Schedule message…2')
  })
})
