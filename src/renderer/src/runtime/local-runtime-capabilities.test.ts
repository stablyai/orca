import { afterEach, expect, it, vi } from 'vitest'
import {
  refreshLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown,
  setLocalRuntimeCapabilitiesForTests
} from './local-runtime-capabilities'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as complete } from '../../../shared/source-control/runtime/source-control-runtime-capabilities'
afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
  vi.unstubAllGlobals()
})
it('keeps a declared local capability across transient probe failure and retries an initially unknown probe', async () => {
  const getStatus = vi.fn().mockRejectedValue(new Error('temporary'))
  vi.stubGlobal('window', { api: { runtime: { getStatus } } })
  setLocalRuntimeCapabilitiesForTests([complete])
  expect(await refreshLocalRuntimeCapabilities()).toEqual([complete])
  expect(readLocalRuntimeCapabilitiesOrUnknown()).toEqual([complete])
  setLocalRuntimeCapabilitiesForTests(null)
  expect(await refreshLocalRuntimeCapabilities()).toEqual([])
  expect(readLocalRuntimeCapabilitiesOrUnknown()).toBeNull()
  getStatus.mockResolvedValueOnce({ capabilities: [complete] })
  expect(await refreshLocalRuntimeCapabilities()).toEqual([complete])
})
