import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import type * as HttpLinkDestinations from '@/lib/http-link-destinations'
import type { HttpLinkActionDestinations } from '@/lib/http-link-destinations'
import { handleNativeChatWebLink } from './native-chat-web-link-actions'

const mocks = vi.hoisted(() => ({ openRoutedHttpLink: vi.fn() }))

vi.mock('@/lib/http-link-destinations', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkDestinations>()),
  openRoutedHttpLink: mocks.openRoutedHttpLink
}))

function stubPlatform(isMac: boolean): void {
  vi.stubGlobal('navigator', { userAgent: isMac ? 'Mac OS X' : 'Windows NT 10.0' })
}

type ClickInit = {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  button?: number
}

function click(init: ClickInit = {}) {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    button: 0,
    clientX: 120,
    clientY: 240,
    preventDefault: vi.fn(),
    ...init
  }
}

function deps(
  overrides: {
    destinations?: HttpLinkActionDestinations
    actionsEnabled?: boolean
  } = {}
) {
  const requests: LinkActionRequest[] = []
  return {
    requests,
    deps: {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' } as const,
      destinations: overrides.destinations ?? { primary: 'system', alternate: 'orca' },
      actionsEnabled: overrides.actionsEnabled ?? true,
      restoreFocus: vi.fn(),
      request: (request: LinkActionRequest) => requests.push(request)
    }
  }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('handleNativeChatWebLink', () => {
  it('anchors keyboard activation to the focused link', () => {
    stubPlatform(true)
    const { deps: d, requests } = deps()
    handleNativeChatWebLink(
      {
        ...click(),
        detail: 0,
        currentTarget: {
          getBoundingClientRect: () => ({ left: 80, bottom: 160 }) as DOMRect
        }
      },
      'https://example.com',
      d
    )
    expect(requests[0]).toMatchObject({ anchorX: 80, anchorY: 160 })
  })

  it('opens the destination popover on a plain click', () => {
    stubPlatform(true)
    const { deps: d, requests } = deps()
    const event = click()

    expect(handleNativeChatWebLink(event, 'https://example.com/', d)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.openRoutedHttpLink).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      anchorX: 120,
      anchorY: 240,
      destination: 'https://example.com/',
      kind: 'url'
    })
    expect(requests[0]?.primary.label).toBe('System Browser')
    expect(requests[0]?.alternate?.label).toBe('Orca Browser')
  })

  it('routes the popover actions to their destinations', () => {
    stubPlatform(true)
    const { deps: d, requests } = deps()
    handleNativeChatWebLink(click(), 'https://example.com/', d)

    void requests[0]?.alternate?.run()
    expect(mocks.openRoutedHttpLink).toHaveBeenCalledWith('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' },
      modifierHeld: false,
      forceDestination: 'orca'
    })
  })

  it('opens the primary destination directly on a modifier click', () => {
    stubPlatform(true)
    const { deps: d, requests } = deps()
    const event = click({ metaKey: true })

    expect(handleNativeChatWebLink(event, 'https://example.com/', d)).toBe(true)
    expect(requests).toHaveLength(0)
    expect(mocks.openRoutedHttpLink).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ forceDestination: 'system' })
    )
  })

  it('opens the alternate destination on a shift+modifier click', () => {
    stubPlatform(false)
    const { deps: d } = deps()

    expect(handleNativeChatWebLink(click({ ctrlKey: true, shiftKey: true }), 'https://a/', d)).toBe(
      true
    )
    expect(mocks.openRoutedHttpLink).toHaveBeenCalledWith(
      'https://a/',
      expect.objectContaining({ forceDestination: 'orca' })
    )
  })

  it('falls back to the primary destination when no alternate is offered', () => {
    stubPlatform(true)
    const { deps: d } = deps({ destinations: { primary: 'system' } })

    handleNativeChatWebLink(click({ metaKey: true, shiftKey: true }), 'https://a/', d)
    expect(mocks.openRoutedHttpLink).toHaveBeenCalledWith(
      'https://a/',
      expect.objectContaining({ forceDestination: 'system' })
    )
  })

  it('opens the link outright on a plain click when link actions are disabled', () => {
    stubPlatform(true)
    const { deps: d, requests } = deps({ actionsEnabled: false })
    const event = click()

    expect(handleNativeChatWebLink(event, 'https://example.com/', d)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(0)
    expect(mocks.openRoutedHttpLink).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ forceDestination: 'system' })
    )
  })

  it.each([
    ['shift-only click', { shiftKey: true }],
    ['alt click', { altKey: true }],
    ['middle click', { button: 1 }],
    ['mac ctrl click', { ctrlKey: true }]
  ])('leaves the anchor default for a %s', (_label, init) => {
    stubPlatform(true)
    const { deps: d, requests } = deps()
    const event = click(init)

    expect(handleNativeChatWebLink(event, 'https://example.com/', d)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
    expect(mocks.openRoutedHttpLink).not.toHaveBeenCalled()
  })
})
