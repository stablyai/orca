import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerHttpLinkStoreAccessor,
  registerRuntimeHttpLinkBrowserOpener
} from '@/lib/http-link-routing'
import {
  closeTerminalLinkActionRequest,
  requestTerminalLinkAction,
  type TerminalLinkActionContext,
  type TerminalLinkActionRequest
} from './terminal-link-action-request'
import { handleOscLink } from './terminal-osc-link-routing'
import { handleTerminalHttpLink } from './terminal-url-link-hit-testing'

const openUrl = vi.fn()
const createBrowserTab = vi.fn()
const setActiveWorktree = vi.fn()
const openRuntimeBrowserTab = vi.fn(() => Promise.resolve())

function plainEvent(): MouseEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    clientX: 40,
    clientY: 60,
    preventDefault: vi.fn()
  } as unknown as MouseEvent
}

function actionContext(request = vi.fn()): TerminalLinkActionContext {
  return {
    paneId: 7,
    pointerGesture: { canRequestAction: () => true, dispose: vi.fn() },
    claimPtyMouse: vi.fn(() => true),
    request,
    focusTerminal: vi.fn()
  }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  vi.stubGlobal('window', { api: { shell: { openUrl } } })
  registerHttpLinkStoreAccessor(() => ({
    settings: { openLinksInApp: false },
    setActiveWorktree,
    createBrowserTab
  }))
  registerRuntimeHttpLinkBrowserOpener(openRuntimeBrowserTab)
})

afterEach(() => {
  registerRuntimeHttpLinkBrowserOpener(null)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('terminal link action routing', () => {
  it('keeps a replacement request when the previous popover dismisses', () => {
    const first = { destination: 'https://first.example' } as TerminalLinkActionRequest
    const second = { destination: 'https://second.example' } as TerminalLinkActionRequest

    expect(closeTerminalLinkActionRequest(second, first)).toBe(second)
    expect(closeTerminalLinkActionRequest(first, first)).toBeNull()
  })

  it('claims PTY mouse ownership only after the pointer gesture is eligible', () => {
    const claimPtyMouse = vi.fn(() => true)
    const request = vi.fn()
    const context = actionContext(request)
    context.claimPtyMouse = claimPtyMouse

    expect(
      requestTerminalLinkAction(plainEvent(), context, {
        destination: 'https://example.com',
        kind: 'url',
        primary: { label: 'Open', run: vi.fn() }
      })
    ).toBe(true)
    expect(claimPtyMouse).toHaveBeenCalledOnce()
    expect(claimPtyMouse.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0]
    )
  })

  it('leaves PTY mouse ownership with an ineligible pointer gesture', () => {
    const context = actionContext()
    context.pointerGesture.canRequestAction = () => false

    expect(
      requestTerminalLinkAction(plainEvent(), context, {
        destination: 'https://example.com',
        kind: 'url',
        primary: { label: 'Open', run: vi.fn() }
      })
    ).toBe(false)
    expect(context.claimPtyMouse).not.toHaveBeenCalled()
    expect(context.request).not.toHaveBeenCalled()
  })

  it('leaves the action closed when the child already owns the gesture', () => {
    const context = actionContext()
    context.claimPtyMouse = vi.fn(() => false)

    expect(
      requestTerminalLinkAction(plainEvent(), context, {
        destination: 'https://example.com',
        kind: 'url',
        primary: { label: 'Open', run: vi.fn() }
      })
    ).toBe(false)
    expect(context.request).not.toHaveBeenCalled()
  })

  it('offers system browser first and Orca second when system browser is the default', () => {
    const request = vi.fn()
    const event = plainEvent()

    expect(
      handleTerminalHttpLink('https://example.com/path', event, {
        worktreeId: 'wt-1',
        linkActionContext: actionContext(request),
        actionDestinations: { primary: 'system', alternate: 'orca' }
      })
    ).toBe(true)
    expect(openUrl).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 7,
        anchorX: 40,
        anchorY: 60,
        destination: 'https://example.com/path',
        kind: 'url'
      })
    )
    expect(request.mock.calls[0][0].primary.label).toBe('System Browser')
    expect(request.mock.calls[0][0].primary.external).toBe(true)
    expect(request.mock.calls[0][0].alternate.label).toBe('Orca Browser')
    expect(request.mock.calls[0][0].alternate.external).toBe(false)

    request.mock.calls[0][0].primary.run()
    expect(openUrl).toHaveBeenCalledWith('https://example.com/path')

    request.mock.calls[0][0].alternate.run()
    expect(createBrowserTab).toHaveBeenCalledWith('wt-1', 'https://example.com/path', {
      activate: true
    })
  })

  it('offers Orca first and system browser second when Orca is the default', () => {
    const request = vi.fn()

    handleTerminalHttpLink('https://example.com/path', plainEvent(), {
      worktreeId: 'wt-1',
      linkActionContext: actionContext(request),
      actionDestinations: { primary: 'orca', alternate: 'system' }
    })

    expect(request.mock.calls[0][0].primary.label).toBe('Orca Browser')
    expect(request.mock.calls[0][0].primary.external).toBe(false)
    expect(request.mock.calls[0][0].alternate.label).toBe('System Browser')
    expect(request.mock.calls[0][0].alternate.external).toBe(true)

    request.mock.calls[0][0].primary.run()
    expect(createBrowserTab).toHaveBeenCalledWith('wt-1', 'https://example.com/path', {
      activate: true
    })

    request.mock.calls[0][0].alternate.run()
    expect(openUrl).toHaveBeenCalledWith('https://example.com/path')
  })

  it('offers only the system browser for a remote link', () => {
    const request = vi.fn()

    handleTerminalHttpLink('https://example.com/path', plainEvent(), {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' },
      linkActionContext: actionContext(request),
      actionDestinations: { primary: 'system' }
    })

    expect(request.mock.calls[0][0].primary.label).toBe('System Browser')
    expect(request.mock.calls[0][0].primary.external).toBe(true)
    expect(request.mock.calls[0][0].alternate).toBeUndefined()
  })

  it('routes an explicit Orca Browser action to the owning runtime', () => {
    const request = vi.fn()

    handleTerminalHttpLink('https://example.com/path', plainEvent(), {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' },
      linkActionContext: actionContext(request),
      actionDestinations: { primary: 'system', alternate: 'orca' }
    })

    request.mock.calls[0][0].primary.run()
    expect(openUrl).toHaveBeenCalledWith('https://example.com/path')
    request.mock.calls[0][0].alternate.run()
    expect(openRuntimeBrowserTab).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: 'https://example.com/path',
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: 'env-1'
    })
    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('uses Shift+modifier for the alternate local destination', () => {
    const event = { ...plainEvent(), metaKey: true, shiftKey: true }

    handleTerminalHttpLink('https://example.com/path', event, {
      worktreeId: 'wt-1',
      actionDestinations: { primary: 'system', alternate: 'orca' }
    })

    expect(createBrowserTab).toHaveBeenCalledWith('wt-1', 'https://example.com/path', {
      activate: true
    })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('keeps Shift+modifier on the only capability-backed destination', () => {
    const event = { ...plainEvent(), metaKey: true, shiftKey: true }

    handleTerminalHttpLink('https://example.com/path', event, {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' },
      actionDestinations: { primary: 'system' }
    })

    expect(openUrl).toHaveBeenCalledWith('https://example.com/path')
    expect(openRuntimeBrowserTab).not.toHaveBeenCalled()
  })

  it('exposes the actual hidden OSC 8 destination', () => {
    const request = vi.fn()
    const destination = 'https://example.com'

    expect(
      handleOscLink(destination, plainEvent(), {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        startupCwd: '/repo',
        linkActionContext: actionContext(request)
      })
    ).toBe(true)
    expect(request.mock.calls[0][0].destination).toBe(destination)
  })
})
