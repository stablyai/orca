import { afterEach, expect, it, vi } from 'vitest'
import { clearPairingInputFromAddressBar } from './web-pairing'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['?orcaWindow=worker&code=secret', '#pairing=secret', '?orcaWindow=worker'],
  ['?pairing=secret&unrelated=value', '#token=secret', '']
])(
  'clears credentials while preserving only the worker-window marker from %s',
  (search, hash, expected) => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: { origin: 'http://127.0.0.1:6768', pathname: '/web-index.html', search, hash },
      history: { replaceState }
    })
    vi.stubGlobal('document', { title: 'Orca' })
    clearPairingInputFromAddressBar()
    expect(replaceState).toHaveBeenCalledWith(
      null,
      'Orca',
      `http://127.0.0.1:6768/web-index.html${expected}`
    )
  }
)
