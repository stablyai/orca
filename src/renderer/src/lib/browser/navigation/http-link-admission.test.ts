import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openOwnedHttpLink,
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener,
  type HttpLinkAdmission,
  type HttpLinkStoreState
} from './http-link-routing'
import type { WorkspaceHttpLinkBrowserOpener } from './http-link-destinations'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

const openUrl = vi.fn<(url: string) => Promise<void>>()
const LOCAL = { kind: 'local' } as const
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function storeState(): HttpLinkStoreState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a minimal store: admission reads only settings and the browser opener seam.
  return {
    settings: { openLinksInApp: true },
    setActiveWorktree: vi.fn()
  } as unknown as HttpLinkStoreState
}

function open(
  url: string,
  extra: Partial<Parameters<typeof openOwnedHttpLink>[1]> = {}
): HttpLinkAdmission[] {
  const outcomes: HttpLinkAdmission[] = []
  openOwnedHttpLink(url, {
    sourceOwner: LOCAL,
    onAdmission: (outcome) => {
      outcomes.push(outcome)
    },
    ...extra
  })
  return outcomes
}

beforeEach(() => {
  toastError.mockReset()
  openUrl.mockReset()
  Object.assign(globalThis, { window: { api: { shell: { openUrl } } } })
  registerHttpLinkStoreAccessor(storeState)
})
afterEach(() => registerWorkspaceHttpLinkBrowserOpener(null))

describe('link open admission', () => {
  it('settles once from the detailed opener outcome and keeps the opener projection', async () => {
    const opener: WorkspaceHttpLinkBrowserOpener = async (request) => {
      request.linkContext?.onDetailedOutcome?.({ status: 'refused' })
      throw new Error('This link cannot open in the workspace browser.')
    }
    registerWorkspaceHttpLinkBrowserOpener(opener)
    const outcomes = open('https://example.test/', { worktreeId: 'wt', forceInApp: true })
    await settle()
    expect(outcomes).toEqual(['refused'])
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('settles an opener without a detailed outcome from its page id', async () => {
    registerWorkspaceHttpLinkBrowserOpener(async () => 'page-1')
    const outcomes = open('https://example.test/', { worktreeId: 'wt', forceInApp: true })
    await settle()
    expect(outcomes).toEqual(['admitted'])
  })

  it('settles a rejected opener as failed', async () => {
    registerWorkspaceHttpLinkBrowserOpener(async () => {
      throw new Error('boom')
    })
    const outcomes = open('https://example.test/', { worktreeId: 'wt', forceInApp: true })
    await settle()
    expect(outcomes).toEqual(['failed'])
  })

  it('admits a system-browser open only after the shell accepts it', async () => {
    openUrl.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
    const opened = open('https://example.test/', { forceSystemBrowser: true })
    const denied = open('https://example.test/', { forceSystemBrowser: true })
    await settle()
    expect(opened).toEqual(['admitted'])
    expect(denied).toEqual(['failed'])
  })

  it('refuses a non-http system-browser target without asking the shell', async () => {
    const outcomes = open('ftp://example.test/', { forceSystemBrowser: true })
    await settle()
    expect(outcomes).toEqual(['refused'])
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('refuses an unknown owner and supersedes a stale request', () => {
    expect(open('https://example.test/', { sourceOwner: { kind: 'unknown' } })).toEqual(['refused'])
    expect(
      open('https://example.test/', {
        linkContext: { linkIntent: null, isCurrentRequest: () => false }
      })
    ).toEqual(['superseded'])
  })

  it('contains a throwing or rejecting consumer without changing the open', async () => {
    registerWorkspaceHttpLinkBrowserOpener(async (request) => {
      request.linkContext?.onDetailedOutcome?.({ status: 'refused' })
      return null
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      openOwnedHttpLink('https://example.test/', {
        sourceOwner: LOCAL,
        worktreeId: 'wt',
        forceInApp: true,
        onAdmission: () => {
          throw new Error('consumer')
        }
      })
    ).not.toThrow()
    openOwnedHttpLink('https://example.test/', {
      sourceOwner: LOCAL,
      worktreeId: 'wt',
      forceInApp: true,
      onAdmission: async () => {
        throw new Error('async consumer')
      }
    })
    await settle()
    expect(error).toHaveBeenCalledTimes(2)
    expect(toastError).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
