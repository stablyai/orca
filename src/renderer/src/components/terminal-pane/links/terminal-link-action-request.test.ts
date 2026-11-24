import { describe, expect, it, vi } from 'vitest'
import {
  requestTerminalLinkAction,
  type TerminalLinkActionContext
} from './terminal-link-action-request'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'

function context(overrides: Partial<TerminalLinkActionContext>): TerminalLinkActionContext & {
  requests: LinkActionRequest[]
} {
  const requests: LinkActionRequest[] = []
  return {
    requests,
    paneId: 1,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a pointer-gesture fake: the chooser path calls only canRequestAction.
    pointerGesture: {
      canRequestAction: () => true
    } as unknown as TerminalLinkActionContext['pointerGesture'],
    claimPtyMouse: () => true,
    request: (request) => requests.push(request),
    focusTerminal: () => {},
    ...overrides
  }
}

function click(button = 0): MouseEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial MouseEvent: routing reads only button, detail and modifier keys.
  return {
    button,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {}
  } as unknown as MouseEvent
}

const details = (kind: 'url' | 'file', run = vi.fn()) => ({
  destination: 'https://x.test/',
  kind,
  primary: { label: 'System browser', run },
  rememberEligible: true
})

describe('terminal plain clicks', () => {
  it('opens a URL directly in Open mode even while file clicks still ask', () => {
    const run = vi.fn()
    const ctx = context({ plainClickBehavior: 'actions', httpPlainClickBehavior: 'open' })
    expect(requestTerminalLinkAction(click(), ctx, details('url', run))).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(ctx.requests).toEqual([])
    requestTerminalLinkAction(click(), ctx, details('file'))
    expect(ctx.requests).toHaveLength(1)
  })

  it('leaves URL plain clicks to the terminal app when that is the effective choice', () => {
    const ctx = context({ plainClickBehavior: 'none', httpPlainClickBehavior: 'none' })
    expect(requestTerminalLinkAction(click(), ctx, details('url'))).toBe(false)
  })

  it('never offers Remember on a middle-click chooser', () => {
    const ctx = context({ httpPlainClickBehavior: 'actions', middleClickBehavior: 'actions' })
    requestTerminalLinkAction(click(), ctx, details('url'))
    requestTerminalLinkAction(click(1), ctx, details('url'))
    expect(ctx.requests.map((request) => request.rememberEligible)).toEqual([true, false])
  })
})
