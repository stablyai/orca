// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { useInstalledPluginManifest } from './use-plugin-contribution-source'

const base = {
  manifestVersion: 1,
  id: 'notes',
  publisher: 'acme',
  name: 'Notes',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1
}
const before = pluginManifestSchema.parse({ ...base, version: '1.0.0' })
const after = pluginManifestSchema.parse({ ...base, version: '2.0.0' })

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

describe('useInstalledPluginManifest', () => {
  it('forgets the old manifest when a same-key update changes the installed revision', async () => {
    let resolveNext: (manifest: typeof after) => void = () => {}
    const getInstalledManifest = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockReturnValueOnce(new Promise((resolve) => (resolveNext = resolve)))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { plugins: { getInstalledManifest } }
    })
    const seen: unknown[] = []
    function Probe({ revision }: { revision: string }): null {
      seen.push(useInstalledPluginManifest('acme.notes', revision)?.version)
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Probe revision="sha256-one" />))
    expect(seen.at(-1)).toBe('1.0.0')

    // Why undefined first: pairing 1.0.0's contents with the new fingerprint would misreport trust.
    await act(async () => root?.render(<Probe revision="sha256-two" />))
    expect(seen.at(-1)).toBeUndefined()
    await act(async () => resolveNext(after))
    expect(seen.at(-1)).toBe('2.0.0')
  })
})
