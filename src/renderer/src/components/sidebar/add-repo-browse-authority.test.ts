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

  it('opens nothing for an SSH host, which holds projects only through its server', () => {
    const actions = { browseLocal: vi.fn(), browseRuntime: vi.fn() }

    routeAddRepoBrowse(parseExecutionHostId('ssh:builder'), actions)

    expect(actions.browseLocal).not.toHaveBeenCalled()
    expect(actions.browseRuntime).not.toHaveBeenCalled()
  })
})
