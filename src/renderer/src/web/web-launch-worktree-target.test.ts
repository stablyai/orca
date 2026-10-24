import { describe, expect, it } from 'vitest'
import { consumeLaunchWorktreeTarget } from './web-launch-worktree-target'
import { readPairingInputFromLocation } from './web-pairing'

// A browser address bar: replaceState rewrites what location reports.
function addressBar(initialUrl: string) {
  let url = new URL(initialUrl)
  return {
    location: {
      get hash() {
        return url.hash
      },
      get pathname() {
        return url.pathname
      },
      get search() {
        return url.search
      }
    },
    history: {
      state: null,
      replaceState: (_data: unknown, _unused: string, next?: string | URL | null) => {
        if (next) {
          url = new URL(next, url)
        }
      }
    }
  }
}

const ENTRY = 'http://127.0.0.1:6768/web-index.html'

describe('launch workspace fragment', () => {
  it('takes the workspace and leaves the pairing for the pairing flow', () => {
    const pairing = encodeURIComponent('orca://pair#device-1')
    const host = addressBar(`${ENTRY}#pairing=${pairing}&worktree=repo%2Fwt%201`)

    expect(consumeLaunchWorktreeTarget(host)).toBe('repo/wt 1')
    expect(host.location.hash).toBe(`#pairing=${pairing}`)
    expect(readPairingInputFromLocation(host.location)).toBe('orca://pair#device-1')
  })

  it('clears a workspace-only fragment so a reload does not switch again', () => {
    const host = addressBar(`${ENTRY}?lang=en#worktree=folder%3Aabc`)

    expect(consumeLaunchWorktreeTarget(host)).toBe('folder:abc')
    expect(host.location.hash).toBe('')
    expect(host.location.search).toBe('?lang=en')
    expect(consumeLaunchWorktreeTarget(host)).toBeNull()
  })
})
