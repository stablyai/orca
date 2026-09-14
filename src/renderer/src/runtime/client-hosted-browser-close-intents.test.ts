import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  CLIENT_HOSTED_BROWSER_CLOSE_INTENT_MAX_AGE_MS,
  MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS
} from '../../../shared/client-hosted-browser-close-intent'
import {
  clearClientHostedBrowserCloseIntents,
  collectPendingClientHostedBrowserCloses,
  listClientHostedBrowserCloseIntents,
  recordClientHostedBrowserCloseIntents,
  type ClientHostedBrowserCloseIntentsByEnvironment
} from './client-hosted-browser-close-intents'

const NOW = 1_800_000_000_000

type CloseState = Pick<AppState, 'browserPagesByWorkspace' | 'remoteBrowserPageHandlesByPageId'>

describe('collecting the client-hosted closes an environment owes', () => {
  it('collects a page this desktop hosts under a live placement', () => {
    expect(collect(state({ placement: true }))).toEqual([
      { environmentId: 'env-a', browserPageId: 'remote-a', worktreeId: 'wt-a' }
    ])
  })

  it('collects a restored page whose host has not republished a placement yet', () => {
    expect(collect(state({ restoredClientHosted: true }))).toEqual([
      { environmentId: 'env-a', browserPageId: 'remote-a', worktreeId: 'wt-a' }
    ])
  })

  it('ignores a server-placed page, which no runtime restart can bring back', () => {
    expect(collect(state({}))).toEqual([])
  })

  it('ignores a staged page the host was never told about', () => {
    // Replaying a close at an id the host never minted would be answered as unknown forever.
    expect(collect(state({ placement: true, staged: true }))).toEqual([])
  })

  it('ignores a page owned by an environment this close did not target', () => {
    expect(collect(state({ placement: true }), ['env-b'])).toEqual([])
  })
})

describe('client-hosted browser close intent lifecycle', () => {
  it('records one intent per page and reports no change on a repeat', () => {
    const first = recordClientHostedBrowserCloseIntents({}, [close('remote-a')], NOW)

    expect(first).toEqual({
      'env-a': [{ browserPageId: 'remote-a', worktreeId: 'wt-a', closedAt: NOW }]
    })
    expect(recordClientHostedBrowserCloseIntents(first!, [close('remote-a')], NOW + 1)).toBeNull()
  })

  it('reports no change for an empty close set', () => {
    expect(recordClientHostedBrowserCloseIntents({}, [], NOW)).toBeNull()
  })

  it('lists nothing for a store that has not materialized the map', () => {
    // Why: replay fires and forgets from a status refresh; an absent map must not reject unhandled.
    expect(listClientHostedBrowserCloseIntents(undefined, 'env-a')).toEqual([])
  })

  it('evicts the oldest once one environment exceeds the cap', () => {
    let current: ClientHostedBrowserCloseIntentsByEnvironment = {}
    for (let index = 0; index <= MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS; index += 1) {
      current = recordClientHostedBrowserCloseIntents(current, [close(`remote-${index}`)], NOW)!
    }

    const intents = listClientHostedBrowserCloseIntents(current, 'env-a')
    expect(intents).toHaveLength(MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS)
    expect(intents[0]?.browserPageId).toBe('remote-1')
  })

  it('clears the pages the runtime settled and keeps the rest', () => {
    const current = recordClientHostedBrowserCloseIntents(
      {},
      [close('remote-a'), close('remote-b')],
      NOW
    )!

    const next = clearClientHostedBrowserCloseIntents(current, {
      environmentId: 'env-a',
      browserPageIds: ['remote-a'],
      now: NOW
    })

    expect(next?.['env-a']).toEqual([
      { browserPageId: 'remote-b', worktreeId: 'wt-a', closedAt: NOW }
    ])
  })

  it('drops the environment entirely once nothing is owed', () => {
    const current = recordClientHostedBrowserCloseIntents({}, [close('remote-a')], NOW)!

    expect(
      clearClientHostedBrowserCloseIntents(current, {
        environmentId: 'env-a',
        browserPageIds: ['remote-a'],
        now: NOW
      })
    ).toEqual({})
  })

  it('gives up on a close no reconnect ever settled', () => {
    const current = recordClientHostedBrowserCloseIntents({}, [close('remote-a')], NOW)!

    expect(
      clearClientHostedBrowserCloseIntents(current, {
        environmentId: 'env-a',
        browserPageIds: [],
        now: NOW + CLIENT_HOSTED_BROWSER_CLOSE_INTENT_MAX_AGE_MS + 1
      })
    ).toEqual({})
  })

  it('reports no change when a settled page was never owed', () => {
    const current = recordClientHostedBrowserCloseIntents({}, [close('remote-a')], NOW)!

    expect(
      clearClientHostedBrowserCloseIntents(current, {
        environmentId: 'env-a',
        browserPageIds: ['remote-z'],
        now: NOW
      })
    ).toBeNull()
    expect(
      clearClientHostedBrowserCloseIntents(current, {
        environmentId: 'env-unknown',
        browserPageIds: ['remote-a'],
        now: NOW
      })
    ).toBeNull()
  })
})

function close(browserPageId: string) {
  return { environmentId: 'env-a', browserPageId, worktreeId: 'wt-a' }
}

function collect(closeState: CloseState, environmentIds: string[] = ['env-a']) {
  return collectPendingClientHostedBrowserCloses(closeState, {
    workspaceId: 'workspace-a',
    worktreeId: 'wt-a',
    environmentIds
  })
}

function state(handle: {
  placement?: boolean
  staged?: boolean
  restoredClientHosted?: boolean
}): CloseState {
  return {
    browserPagesByWorkspace: {
      'workspace-a': [{ id: 'page-a', workspaceId: 'workspace-a' }]
    } as unknown as CloseState['browserPagesByWorkspace'],
    remoteBrowserPageHandlesByPageId: {
      'page-a': {
        environmentId: 'env-a',
        remotePageId: 'remote-a',
        ...(handle.placement
          ? {
              placement: {
                kind: 'client' as const,
                browserHostClientId: 'host-a',
                browserHostGeneration: 1,
                pageHostGeneration: 1
              }
            }
          : {}),
        ...(handle.staged ? { staged: true as const } : {}),
        ...(handle.restoredClientHosted ? { restoredClientHosted: true as const } : {})
      }
    }
  }
}
