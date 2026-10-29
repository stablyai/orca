import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

const LOCALES_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url))
const LOCALE_FILES = readdirSync(LOCALES_DIR).filter((file) => file.endsWith('.json'))

function readLocaleDescription(file: string): string {
  const catalog = JSON.parse(readFileSync(`${LOCALES_DIR}${file}`, 'utf8'))
  return String(catalog.auto.components.sidebar.AddWslHostFormPanel.description)
}

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

  it('says bridge projects move to the host on their own, and how to bring one back', () => {
    // Verify bug 9: "keep working as they are" and "until you move them" both contradicted the
    // automatic mover, which moves them once their terminals are idle.
    const html = render()
    expect(html).not.toContain('Use it for new projects')
    expect(html).not.toContain('until you move them')
    expect(html).toContain('move to this host automatically once their terminals are idle')
    // Only this distro's projects move; Windows-drive ones never do (move scope refuses /mnt).
    expect(html).toContain('Projects in this distro that you opened through')
    expect(html).toContain('projects on a Windows drive (/mnt/…) stay on this computer')
    expect(html).toContain('bring a moved project back from the sidebar')
  })

  it('carries the same promise in every locale, none still saying projects stay put', () => {
    const stale = [
      'new projects',
      'neue Projekte',
      'novos projetos',
      'новых проектов',
      'Yeni projeler',
      '新專案',
      // Each locale's old "until you move them", as the catalog carried it before verify bug 9.
      'until you move',
      'hasta que los muevas',
      "jusqu'à ce que vous les déplaciez",
      '移動するまで',
      '옮기기 전까지',
      '直到你将它们移到'
    ]
    for (const file of LOCALE_FILES) {
      const description = readLocaleDescription(file)
      expect(description).toContain('wsl.localhost')
      expect(description).toContain('/mnt/…')
      for (const phrase of stale) {
        expect(description).not.toContain(phrase)
      }
    }
  })

  it('spells out the WSL 2 conversion for a WSL 1 distro the list cannot offer', () => {
    expect(render()).toContain('wsl --set-version Legacy 2')
    expect(render({ distros: [ubuntu] })).not.toContain('wsl --set-version')
  })

  it('says this build cannot run WSL hosts and offers nothing to add', () => {
    const html = render({ selectedDistro: 'Ubuntu', serverFilesMissing: true })
    expect(html).toContain('This build of Orca can’t run WSL hosts (server files missing).')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('wsl --install')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add host<\/button>/)
  })
})
