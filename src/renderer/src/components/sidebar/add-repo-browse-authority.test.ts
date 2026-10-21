import { describe, expect, it, vi } from 'vitest'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { routeAddRepoBrowse } from './add-repo-browse-authority'

describe('routeAddRepoBrowse', () => {
  it('opens paired host browsing without invoking native pickFolders', () => {
    const pickFolders = vi.fn()
    const browseRuntime = vi.fn()

    routeAddRepoBrowse(parseExecutionHostId('runtime:paired-host'), {
      browseLocal: pickFolders,
      browseRuntime
    })

    expect(browseRuntime).toHaveBeenCalledOnce()
    expect(pickFolders).not.toHaveBeenCalled()
  })

  it('preserves native folder browsing for desktop local hosts', () => {
    const pickFolders = vi.fn()

    routeAddRepoBrowse(parseExecutionHostId('local'), {
      browseLocal: pickFolders,
      browseRuntime: vi.fn()
    })

    expect(pickFolders).toHaveBeenCalledOnce()
  })

  it('opens nothing for an SSH host, which holds projects only through its server', () => {
    const actions = { browseLocal: vi.fn(), browseRuntime: vi.fn() }

    routeAddRepoBrowse(parseExecutionHostId('ssh:builder'), actions)

    expect(actions.browseLocal).not.toHaveBeenCalled()
    expect(actions.browseRuntime).not.toHaveBeenCalled()
  })

  it('opens the Windows folder picker for a WSL host instead of the in-app browser', () => {
    const actions = { browseLocal: vi.fn(), browseRuntime: vi.fn(), browseWslHost: vi.fn() }

    routeAddRepoBrowse(parseExecutionHostId('runtime:wsl%3AUbuntu'), actions)

    expect(actions.browseWslHost).toHaveBeenCalledOnce()
    expect(actions.browseRuntime).not.toHaveBeenCalled()
    expect(actions.browseLocal).not.toHaveBeenCalled()
  })
})
