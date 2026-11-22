import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import type { TerminalLinkActionContext } from '../terminal-link-action-request'
import type * as HttpLinkDestinations from '@/lib/browser/navigation/http-link-destinations'
import { handleTerminalHttpLink } from './terminal-url-link-hit-testing'

const { openRoutedHttpLink } = vi.hoisted(() => ({ openRoutedHttpLink: vi.fn() }))
vi.mock('@/lib/browser/navigation/http-link-destinations', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkDestinations>()),
  openRoutedHttpLink
}))
vi.mock('@/lib/links/preferences/link-action-context', () => ({
  captureLinkActionContext: () => ({ linkIntent: null, groupIntent: null, clickHostId: 'local' })
}))

const URL = 'https://example.com/'
const requestPreference = vi.fn()

function click(modifiers: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    clientX: 0,
    clientY: 0,
    preventDefault: () => {},
    ...modifiers
  } as unknown as MouseEvent
}

function linkContext(
  httpPlainClickBehavior: 'actions' | 'open',
  requests: LinkActionRequest[]
): TerminalLinkActionContext {
  return {
    paneId: 1,
    pointerGesture: {
      canRequestAction: () => true
    } as unknown as TerminalLinkActionContext['pointerGesture'],
    claimPtyMouse: () => true,
    request: (request) => requests.push(request),
    focusTerminal: () => {},
    plainClickBehavior: 'actions',
    httpPlainClickBehavior,
    rememberMode: httpPlainClickBehavior === 'actions' ? 'ask' : 'open',
    middleClickBehavior: 'actions'
  }
}

function open(event: MouseEvent, behavior: 'actions' | 'open', requests: LinkActionRequest[] = []) {
  handleTerminalHttpLink(URL, event, {
    worktreeId: 'w',
    sourceTabId: 'tab',
    sourceOwner: { kind: 'local' },
    requestOpenLinksInAppPreference: requestPreference,
    linkActionContext: linkContext(behavior, requests),
    actionDestinations: { primary: 'system', alternate: 'orca' }
  })
  return requests
}

beforeEach(() => {
  openRoutedHttpLink.mockReset()
  requestPreference.mockReset()
})

// The legacy one-time browser dialog runs only for an open with no forced destination.
describe('terminal URL opens never reach the legacy browser dialog', () => {
  it('forces a destination on modifier clicks', () => {
    open(click({ metaKey: true, ctrlKey: true }), 'actions')
    open(click({ metaKey: true, ctrlKey: true, shiftKey: true }), 'actions')
    expect(openRoutedHttpLink.mock.calls.map(([, deps]) => deps.forceDestination)).toEqual([
      'system',
      'orca'
    ])
  })

  it('forces the saved browser on a plain click in Open mode', () => {
    open(click(), 'open')
    expect(openRoutedHttpLink).toHaveBeenCalledOnce()
    expect(openRoutedHttpLink.mock.calls[0]![1].forceDestination).toBe('system')
  })

  it('forces the chosen browser from every chooser row, plain or middle click', async () => {
    const requests = [...open(click(), 'actions'), ...open(click({ button: 1 }), 'actions')]
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      await request.primary.run()
      await request.alternate!.run()
    }
    expect(openRoutedHttpLink.mock.calls.map(([, deps]) => deps.forceDestination)).toEqual([
      'system',
      'orca',
      'system',
      'orca'
    ])
    expect(requestPreference).not.toHaveBeenCalled()
  })

  it('saves nothing from a ticked middle-click chooser row', async () => {
    const [request] = open(click({ button: 1 }), 'actions')
    await request!.primary.run({ remember: true })
    expect(request!.rememberEligible).toBe(false)
    expect(openRoutedHttpLink.mock.calls[0]![1].onAdmission).toBeUndefined()
  })
})
