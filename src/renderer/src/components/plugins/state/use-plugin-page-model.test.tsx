// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { pluginListEntryFromListing, type PluginListEntry } from '../list/plugin-list-entries'
import type { PluginPagePreview } from './use-plugin-catalog'
import { usePluginPageModel } from './use-plugin-page-model'

it('pins catalog provenance with its listing until the newer entry is selected', async () => {
  const original = pluginListEntryFromListing(
    {
      pluginKey: 'acme.notes',
      marketplaceSourceId: 'first',
      marketplaceName: 'Community',
      marketplaceOwner: 'catalog',
      marketplaceCommit: 'a',
      source: { kind: 'git', url: 'https://github.com/acme/notes', ref: 'main' },
      categories: [],
      official: false,
      bundled: false
    },
    ['first'],
    'https://github.com/first/catalog'
  )
  const newer = pluginListEntryFromListing(
    {
      ...original.listing!,
      marketplaceSourceId: 'second',
      marketplaceCommit: 'b'
    },
    ['second'],
    'https://gitlab.com/second/catalog'
  )
  const fetchPreview = () => new Promise<PluginPagePreview>(() => undefined)
  let model: ReturnType<typeof usePluginPageModel> | undefined
  function Harness({ entry }: { entry: PluginListEntry }) {
    model = usePluginPageModel({ entry, fetchPreview, refreshing: false })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Harness entry={original} />))
    expect(model?.entry.verifiedSource).toEqual({
      kind: 'catalog',
      catalog: 'Community',
      owner: 'github.com/first'
    })
    await act(async () => root.render(<Harness entry={newer} />))
    expect(model?.entry.verifiedSource).toEqual({
      kind: 'catalog',
      catalog: 'Community',
      owner: 'github.com/first'
    })
    expect(model?.listing?.marketplaceSourceId).toBe('first')
    await act(async () => model?.showNewer())
    expect(model?.entry.verifiedSource).toEqual({
      kind: 'catalog',
      catalog: 'Community',
      owner: 'gitlab.com/second'
    })
    expect(model?.listing?.marketplaceSourceId).toBe('second')
  } finally {
    act(() => root.unmount())
  }
})
