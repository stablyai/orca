// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api/plugins/plugin-host-api'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }))
const { usePluginInstallAction } = await import('./use-plugin-install-action')
const { toast } = await import('sonner')

const SOURCE = { kind: 'git' as const, url: 'https://github.com/samples/demo.git', ref: 'main' }
const manifest = pluginManifestSchema.parse({
  manifestVersion: 2,
  id: 'demo',
  publisher: 'samples',
  name: 'Demo',
  version: '1.1.0',
  execution: 'declarative',
  license: 'MIT',
  engines: { orca: '>=1.4.248' },
  capabilities: [],
  contributes: { commands: [{ id: 'demo.open', title: 'Open', action: 'sidebar.left.toggle' }] }
})
const preview: PluginMarketplaceHostInstallPreview = {
  marketplaceSourceId: 'a'.repeat(32),
  marketplaceName: 'Samples',
  marketplaceOwner: 'samples',
  marketplaceCommit: 'c'.repeat(40),
  pluginKey: 'samples.demo',
  source: SOURCE,
  resolvedCommit: 'b'.repeat(40),
  contentHash: 'b'.repeat(64),
  consentFingerprint: 'reviewed',
  official: true,
  bundled: false,
  manifest
}
// Why a partial listing: the hook reads only these fields; the rest of the catalog row is unused here.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture carries only the fields the hook reads
const listing = {
  marketplaceSourceId: preview.marketplaceSourceId,
  marketplaceCommit: preview.marketplaceCommit,
  pluginKey: 'samples.demo',
  name: 'Demo',
  source: SOURCE,
  official: true,
  bundled: false
} as PluginMarketplaceHostListing

function stubInstall(consent: () => Promise<unknown>): void {
  Object.assign(window, {
    api: {
      plugins: {
        installMarketplacePlugin: vi.fn(async () => ({ ok: true, consentFingerprint: 'reviewed' })),
        consent: vi.fn(consent)
      }
    }
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  Reflect.deleteProperty(window, 'api')
})

/** The action of the success toast the install shows, or undefined when it offers none. */
async function installAndReadTryIt() {
  const { result } = renderHook(() =>
    usePluginInstallAction({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page preview is unused when the approval preview is passed
      fetchPreview: async () => ({ ok: true, preview }) as never,
      onInstalled: async () => undefined
    })
  )
  await act(() => result.current.install(listing, { preview }))
  return vi.mocked(toast.success).mock.calls[0]?.[1]?.action
}

it('offers Try it only when the approval that turns the plugin on was applied', async () => {
  stubInstall(async () => {
    throw new Error('marketplace changed after preview; review the plugin again')
  })
  expect(await installAndReadTryIt()).toBeUndefined()
  expect(toast.success).toHaveBeenCalledTimes(1)
})

it('offers Try it once the approval applied', async () => {
  stubInstall(async () => undefined)
  expect(await installAndReadTryIt()).toMatchObject({ label: expect.any(String) })
})
