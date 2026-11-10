import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AddRepoHostSelector } from './project-admission/host-selection/AddRepoHostSelector'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    disabled,
    className,
    'aria-disabled': ariaDisabled
  }: {
    children: React.ReactNode
    disabled?: boolean
    className?: string
    'aria-disabled'?: React.AriaAttributes['aria-disabled']
  }) => (
    <div aria-disabled={ariaDisabled ?? disabled} className={className}>
      {children}
    </div>
  )
}))

function renderSelector(selectedHostId: 'local' | 'ssh:ssh-1'): string {
  return renderToStaticMarkup(
    <AddRepoHostSelector
      hosts={[
        {
          id: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          kind: 'local',
          health: 'local',
          presence: 'local'
        },
        {
          id: 'ssh:ssh-1',
          label: 'Builder',
          detail: 'SSH',
          kind: 'ssh',
          health: 'disconnected',
          presence: 'configured'
        }
      ]}
      selectedHostId={selectedHostId}
      open={false}
      onOpenChange={vi.fn()}
      onSelectHost={vi.fn()}
    />
  )
}

describe('AddRepoHostSelector', () => {
  it('shows disconnected SSH hosts with a connect action in Add Project', () => {
    const html = renderSelector('ssh:ssh-1')

    expect(html).toContain('Builder')
    expect(html).toContain('Disconnected')
    expect(html).toContain('Connect')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('cursor-not-allowed')
    expect(html).not.toContain('opacity-55')
    // One status dot on the trigger and one on the Builder row.
    expect(html.match(/bg-muted-foreground\/40/g)).toHaveLength(2)
    expect(html).toContain('data-variant="outline"')
    // The visible status label already names a remote host's state.
    expect(html).not.toContain('sr-only')
  })

  it('names the local status for screen readers on the trigger', () => {
    expect(renderSelector('local')).toContain('<span class="sr-only">Local</span>')
  })
})
