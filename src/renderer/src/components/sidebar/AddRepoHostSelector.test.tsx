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
        selectedOptionId="local"
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
        selectedOptionId="ssh:ssh-1"
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
        selectedOptionId="runtime:old-server"
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

  it('lists WSL distro rows with readiness and no connect action', () => {
    const html = renderToStaticMarkup(
      <AddRepoHostSelector
        hosts={[
          {
            id: 'local',
            label: 'Local Windows',
            detail: 'This computer',
            kind: 'local',
            health: 'local',
            presence: 'local'
          },
          {
            id: 'wsl-distro:Ubuntu',
            kind: 'wsl-distro',
            wslDistro: 'Ubuntu',
            label: 'WSL · Ubuntu',
            detail: 'Windows Linux subsystem · ready',
            health: 'available'
          },
          {
            id: 'wsl-distro:Debian',
            kind: 'wsl-distro',
            wslDistro: 'Debian',
            label: 'WSL · Debian',
            detail: 'Windows Linux subsystem · start on first use',
            health: 'disconnected'
          }
        ]}
        selectedOptionId="wsl-distro:Ubuntu"
        open
        onOpenChange={vi.fn()}
        onSelectHost={vi.fn()}
      />
    )

    expect(html).toContain('WSL · Ubuntu')
    expect(html).toContain('WSL · Debian')
    expect(html).toContain('Windows Linux subsystem · ready')
    expect(html).toContain('Windows Linux subsystem · start on first use')
    // Why: WSL rows are local-host sub-modes, never SSH-style connect targets.
    // 'Connect<' rather than 'Connect' so the trigger's 'Connected' badge passes.
    expect(html).not.toContain('Connect<')
  })
})
