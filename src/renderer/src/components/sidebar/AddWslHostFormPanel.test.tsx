import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WslHostDistro } from '../../../../shared/wsl-host-types'
import { AddWslHostFormPanel, canAddWslDistro, wslDistroStateLabel } from './AddWslHostFormPanel'

vi.mock('@/components/ui/dialog', () => ({
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
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
  it('labels each distro and refuses WSL 1 and already-added ones', () => {
    expect(wslDistroStateLabel(ubuntu)).toBe('Running')
    expect(wslDistroStateLabel(debian)).toBe('Stopped')
    expect(wslDistroStateLabel(legacy)).toBe('WSL 1 · not supported')
    expect(wslDistroStateLabel(added)).toBe('Already a host')
    expect([ubuntu, debian, legacy, added].map(canAddWslDistro)).toEqual([true, true, false, false])
  })

  it('does not promise bridge projects stay put once they can move to the host', () => {
    // "Use it for new projects; ... keep working as they are" contradicted the mover.
    const html = render()
    expect(html).not.toContain('Use it for new projects')
    expect(html).toContain('until you move them to this host')
  })

  it('says this build cannot run WSL hosts and offers nothing to add', () => {
    const html = render({ selectedDistro: 'Ubuntu', serverFilesMissing: true })
    expect(html).toContain('This build of Orca can’t run WSL hosts (server files missing).')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('wsl --install')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add host<\/button>/)
  })
})
