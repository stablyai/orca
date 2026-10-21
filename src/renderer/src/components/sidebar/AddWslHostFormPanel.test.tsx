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

  it('makes starting a stopped distro an explicit action', () => {
    const html = render({ selectedDistro: 'Debian' })
    expect(html).toContain('Debian is stopped. Adding it starts it.')
    expect(html).toContain('Start and add')
    expect(render({ selectedDistro: 'Ubuntu' })).toContain('Add host')
  })

  it('shows a refusal inline and the setup progress while adding', () => {
    expect(render({ error: 'Already runs the Orca server for “dev”.' })).toContain('role="alert"')
    const adding = render({ selectedDistro: 'Ubuntu', adding: true })
    expect(adding).toContain('Setting up…')
    expect(adding).toContain('The first time can take a minute.')
  })

  it('explains an empty list', () => {
    expect(render({ distros: [] })).toContain('wsl --install')
  })

  it('says this build cannot run WSL hosts and offers nothing to add', () => {
    const html = render({ selectedDistro: 'Ubuntu', serverFilesMissing: true })
    expect(html).toContain('This build of Orca can’t run WSL hosts (server files missing).')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('wsl --install')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add host<\/button>/)
  })

  it('offers an explicit refresh, and none when nothing could be added', () => {
    expect(render()).toContain('Refresh')
    expect(render({ serverFilesMissing: true })).not.toContain('Refresh')
  })
})
