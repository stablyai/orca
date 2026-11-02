import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AddRepoHostSelector } from './AddRepoHostSelector'

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

describe('AddRepoHostSelector', () => {
  it('shows a remote host setup menu when Local Mac is the only host', () => {
    const html = renderToStaticMarkup(
      <AddRepoHostSelector
        hosts={[
          {
            id: 'local',
            label: 'Local Mac',
            detail: 'This computer',
            kind: 'local',
            health: 'local',
            presence: 'local'
          }
        ]}
        selectedHostId="local"
        open
        onOpenChange={vi.fn()}
        onSelectHost={vi.fn()}
        onAddSshHost={vi.fn()}
        onAddRemoteServer={vi.fn()}
      />
    )

    expect(html).toContain('Add remote host')
    expect(html).toContain('Add SSH host')
    expect(html).toContain('Use an existing machine over SSH.')
    expect(html).toContain('Add remote server')
    expect(html).toContain('Pair with Orca running on another computer.')
  })

  it('shows disconnected SSH hosts with a connect action in Add Project', () => {
    const html = renderToStaticMarkup(
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
        selectedHostId="ssh:ssh-1"
        open={false}
        onOpenChange={vi.fn()}
        onSelectHost={vi.fn()}
      />
    )

    expect(html).toContain('Builder')
    expect(html).toContain('Disconnected')
    expect(html).toContain('Connect')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('cursor-not-allowed')
    expect(html).not.toContain('opacity-55')
  })

  it('shows exact update guidance for incompatible runtime hosts', () => {
    const html = renderToStaticMarkup(
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
            id: 'runtime:old-server',
            label: 'Old server',
            detail: 'Orca server',
            kind: 'runtime',
            health: 'blocked',
            presence: 'active',
            compatibility: {
              kind: 'blocked',
              reason: 'server-too-old',
              clientProtocolVersion: 5,
              serverProtocolVersion: 1,
              requiredServerProtocolVersion: 4
            }
          }
        ]}
        selectedHostId="runtime:old-server"
        open
        onOpenChange={vi.fn()}
        onSelectHost={vi.fn()}
      />
    )

    expect(html).toContain('Update needed')
    expect(html).toContain('The selected Orca server is too old for this client.')
    expect(html).toContain('Update Orca on the server.')
    expect(html).toContain('aria-disabled="true"')
  })

  it('offers Add WSL distro only when given, and a connect action on a stopped WSL host', () => {
    const hosts = [
      {
        id: 'local' as const,
        label: 'Local PC',
        detail: 'This computer',
        kind: 'local' as const,
        health: 'local' as const,
        presence: 'local' as const
      },
      {
        id: 'runtime:wsl%3Aubuntu' as const,
        label: 'Ubuntu (WSL)',
        detail: 'WSL distro · Distro stopped',
        kind: 'runtime' as const,
        health: 'disconnected' as const,
        presence: 'project' as const,
        wslDistro: 'Ubuntu'
      }
    ]
    const withWsl = renderToStaticMarkup(
      <AddRepoHostSelector
        hosts={hosts}
        selectedHostId="local"
        open
        onOpenChange={vi.fn()}
        onSelectHost={vi.fn()}
        onAddSshHost={vi.fn()}
        onAddWslHost={vi.fn()}
      />
    )
    expect(withWsl).toContain('Add WSL distro')
    expect(withWsl).toContain('Ubuntu (WSL)')
    expect(withWsl).toContain('Distro stopped')
    expect(withWsl).toContain('Connect')

    const withoutWsl = renderToStaticMarkup(
      <AddRepoHostSelector
        hosts={hosts}
        selectedHostId="local"
        open
        onOpenChange={vi.fn()}
        onSelectHost={vi.fn()}
        onAddSshHost={vi.fn()}
      />
    )
    expect(withoutWsl).not.toContain('Add WSL distro')
  })

  it('offers Turn on instead of Connect for a WSL host whose experiment is off', () => {
    const html = renderToStaticMarkup(
      <AddRepoHostSelector
        hosts={[
          {
            id: 'local',
            label: 'Local PC',
            detail: 'This computer',
            kind: 'local',
            health: 'local',
            presence: 'local'
          },
          {
            id: 'runtime:wsl%3Aubuntu',
            label: 'Ubuntu (WSL)',
            detail: 'Turned off in Settings → Experimental',
            kind: 'runtime',
            health: 'disconnected',
            presence: 'project',
            wslDistro: 'Ubuntu',
            wslUnavailable: 'turned-off'
          }
        ]}
        selectedHostId="local"
        open
        onOpenChange={vi.fn()}
        onSelectHost={vi.fn()}
        onOpenWslHostsSetting={vi.fn()}
      />
    )
    expect(html).toContain('Turned off in Settings → Experimental')
    expect(html).not.toContain('Disconnected')
    expect(html).toContain('Turn on')
    expect(html).not.toContain('>Connect<')
  })
})
