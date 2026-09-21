import { describe, expect, it, vi } from 'vitest'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { routeAddRepoBrowse } from './add-repo-browse-authority'

describe('routeAddRepoBrowse', () => {
  it('opens paired host browsing without invoking native pickFolders', () => {
    const pickFolders = vi.fn()
    const browseRuntime = vi.fn()

    routeAddRepoBrowse(parseExecutionHostId('runtime:paired-host'), {
      browseLocal: pickFolders,
      browseRuntime,
      browseSsh: vi.fn()
    })

    expect(browseRuntime).toHaveBeenCalledOnce()
    expect(pickFolders).not.toHaveBeenCalled()
  })

  it('preserves native folder browsing for desktop local hosts', () => {
    const pickFolders = vi.fn()

    routeAddRepoBrowse(parseExecutionHostId('local'), {
      browseLocal: pickFolders,
      browseRuntime: vi.fn(),
      browseSsh: vi.fn()
    })

    expect(pickFolders).toHaveBeenCalledOnce()
  })

  it('preserves SSH host browsing', () => {
    const browseSsh = vi.fn()

    routeAddRepoBrowse(parseExecutionHostId('ssh:builder'), {
      browseLocal: vi.fn(),
      browseRuntime: vi.fn(),
      browseSsh
    })

    expect(browseSsh).toHaveBeenCalledWith('builder')
  })
})
