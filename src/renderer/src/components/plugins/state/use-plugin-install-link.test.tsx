// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginMarketplaceHostSourceState } from '../../../../../preload/api-types'
import { parsePluginInstallLink } from '../../../../../shared/plugins/catalog/plugin-install-link'
import { usePluginPreviewRequestStore } from '@/store/plugin-preview-request'
import { usePluginInstallLink } from './use-plugin-install-link'

const toastError = vi.hoisted(() => vi.fn())
const storeState = vi.hoisted(() => ({
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

const { openPluginInstallLink } = await import('@/store/plugin-preview-request')

let root: Root | null = null
let hook: ReturnType<typeof usePluginInstallLink> | null = null
const open = vi.fn()
const loadMarketplaceData = vi.fn(async () => undefined)
const addMarketplace = vi.fn(async () => ({}))
const installMarketplacePlugin = vi.fn()

function source(url: string, official = false): PluginMarketplaceHostSourceState {
  return {
    id: url,
    source: { kind: 'git', url, ref: 'main' },
    addedAt: 0,
    marketplace: null,
    stale: false,
    official
  }
}
const OFFICIAL = source('https://github.com/stablyai/orca-plugins.git', true)

function Harness(props: { sources: PluginMarketplaceHostSourceState[]; loading: boolean }) {
  hook = usePluginInstallLink({ ...props, loadMarketplaceData, open })
  return null
}

async function render(sources: PluginMarketplaceHostSourceState[], loading = false) {
  if (!root) {
    root = createRoot(document.createElement('div'))
  }
  await act(async () => root!.render(<Harness sources={sources} loading={loading} />))
}

function request(raw: string): void {
  usePluginPreviewRequestStore.setState({ link: parsePluginInstallLink(raw) })
}

beforeEach(() => {
  vi.clearAllMocks()
  usePluginPreviewRequestStore.setState({ request: null, link: null, catalogToAdd: null })
  Object.assign(window, { api: { plugins: { addMarketplace, installMarketplacePlugin } } })
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

describe('openPluginInstallLink', () => {
  it('routes a valid link to Settings → Plugins and holds it for the catalog', () => {
    openPluginInstallLink('orca://plugins/acme.dusk')
    expect(storeState.openSettingsTarget).toHaveBeenCalledWith({ pane: 'plugins', repoId: null })
    expect(storeState.openSettingsPage).toHaveBeenCalled()
    expect(usePluginPreviewRequestStore.getState().link?.pluginKey).toBe('acme.dusk')
  })

  it('shows only an error toast for a malformed link', () => {
    openPluginInstallLink('orca://plugins/../evil')
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(storeState.openSettingsPage).not.toHaveBeenCalled()
    expect(usePluginPreviewRequestStore.getState().link).toBeNull()
  })
})

describe('usePluginInstallLink', () => {
  it('keeps the link while plugins are off, then opens the page once the catalog loads', async () => {
    openPluginInstallLink('orca://plugins/acme.dusk')
    // Plugins off: the catalog isn't mounted, so the link waits.
    expect(usePluginPreviewRequestStore.getState().link).not.toBeNull()
    await render([OFFICIAL], true)
    expect(open).not.toHaveBeenCalled()
    await render([OFFICIAL], false)
    expect(open).toHaveBeenCalledWith('acme.dusk')
    expect(usePluginPreviewRequestStore.getState().link).toBeNull()
    expect(installMarketplacePlugin).not.toHaveBeenCalled()
  })

  it('opens directly when the linked catalog is already added under another spelling', async () => {
    request(
      `orca://plugins/acme.dusk?catalog=${encodeURIComponent('git@github.com:acme/catalog.git')}`
    )
    await render([OFFICIAL, source('https://github.com/acme/catalog')])
    expect(open).toHaveBeenCalledWith('acme.dusk')
    expect(hook?.catalogToAdd).toBeNull()
  })

  it('asks before adding an unknown catalog and fetches nothing until confirmed', async () => {
    request('orca://plugins/acme.dusk?catalog=community')
    await render([OFFICIAL])
    expect(open).not.toHaveBeenCalled()
    expect(addMarketplace).not.toHaveBeenCalled()
    expect(hook?.catalogToAdd?.source.url).toBe(
      'https://github.com/stablyai/orca-community-plugins.git'
    )

    await act(async () => hook!.confirmCatalog())
    expect(addMarketplace).toHaveBeenCalledWith({
      kind: 'git',
      url: 'https://github.com/stablyai/orca-community-plugins.git',
      ref: 'main'
    })
    expect(loadMarketplaceData).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('acme.dusk')
    expect(installMarketplacePlugin).not.toHaveBeenCalled()
  })

  it('cancelling the catalog prompt adds and opens nothing', async () => {
    request(`orca://plugins/acme.dusk?catalog=${encodeURIComponent('https://gitlab.com/a/b.git')}`)
    await render([OFFICIAL])
    act(() => hook!.cancelCatalog())
    await render([OFFICIAL])
    expect(hook?.catalogToAdd).toBeNull()
    expect(addMarketplace).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})
