import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WslHostDistro } from '../../../../shared/wsl-host-types'
import {
  AddWslHostFormPanel,
  canAddWslDistro,
  hasWsl2Distro,
  wsl1DistroReason
} from './AddWslHostFormPanel'

vi.mock('@/components/ui/dialog', () => ({
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

// Renders the options inline, as an open list would.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SelectItem: ({
    children,
    value,
    disabled
  }: {
    children: React.ReactNode
    value: string
    disabled?: boolean
  }) => (
    <li data-value={value} data-disabled={disabled ? 'true' : 'false'}>
      {children}
    </li>
  )
}))

const ubuntu: WslHostDistro = { name: 'Ubuntu', state: 'running', version: 2, environmentId: null }
const debian: WslHostDistro = { name: 'Debian', state: 'stopped', version: 2, environmentId: null }
const legacy: WslHostDistro = { name: 'Legacy', state: 'running', version: 1, environmentId: null }
const added: WslHostDistro = { ...ubuntu, name: 'Arch', environmentId: 'wsl:arch' }

function render(props: Partial<Parameters<typeof AddWslHostFormPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    <AddWslHostFormPanel
      distros={[ubuntu, debian, legacy, added]}
      loading={false}
      refreshing={false}
      selectedDistro=""
      error={null}
      adding={false}
      serverFilesMissing={false}
      onSelectDistro={vi.fn()}
      onRefresh={vi.fn()}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />
  )
}

describe('AddWslHostFormPanel', () => {
  it('says this build cannot run WSL hosts and offers nothing to add', () => {
    const html = render({ selectedDistro: 'Ubuntu', serverFilesMissing: true })
    expect(html).toContain('This build of Orca can’t run WSL hosts (server files missing).')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('wsl --install')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add host<\/button>/)
  })

  it('disables a WSL 1 row and says how to convert it', () => {
    const html = render()
    expect(html).toMatch(/<li data-value="Legacy" data-disabled="true">/)
    expect(html).toMatch(/<li data-value="Ubuntu" data-disabled="false">/)
    expect(html).toContain('WSL 1 can’t run an Orca host; convert with wsl --set-version Legacy 2')
    expect(canAddWslDistro(legacy)).toBe(false)
    expect(wsl1DistroReason('Legacy')).toContain('wsl --set-version Legacy 2')
  })

  it('treats an unreported version as possibly WSL 2', () => {
    expect(hasWsl2Distro([legacy])).toBe(false)
    expect(hasWsl2Distro([legacy, { ...ubuntu, version: null }])).toBe(true)
    expect(hasWsl2Distro([])).toBe(false)
  })

  it('shows install guidance when no distros are found', () => {
    const html = render({ distros: [] })
    expect(html).toContain('No WSL 2 distros found')
    expect(html).toContain('wsl --install')
  })

  it('shows install guidance when only WSL 1 distros are found', () => {
    const html = render({ distros: [legacy] })
    expect(html).toContain('No WSL 2 distros found')
    expect(html).toContain('wsl --set-version Legacy 2')
  })

  it('shows no empty state while listing, after a list error, or with a WSL 2 distro', () => {
    expect(render({ distros: [], loading: true })).not.toContain('No WSL 2 distros found')
    expect(render({ distros: [], error: 'wsl.exe failed' })).not.toContain('No WSL 2 distros found')
    expect(render({ distros: [legacy, debian] })).not.toContain('No WSL 2 distros found')
  })
})
