import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HttpLinkDestinationsModule from '@/lib/browser/navigation/http-link-destinations'

const openRoutedHttpLink = vi.hoisted(() => vi.fn())

vi.mock('@/lib/browser/navigation/http-link-destinations', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpLinkDestinationsModule>()
  return {
    ...actual,
    openRoutedHttpLink
  }
})

import { handleNativeChatWebLink } from './native-chat-web-link-actions'

describe('handleNativeChatWebLink middle-click behavior', () => {
  beforeEach(() => {
    openRoutedHttpLink.mockClear()
  })

  it('opens web links in the system browser in the background on middle-click', () => {
    const preventDefault = vi.fn()
    const request = vi.fn()

    const handled = handleNativeChatWebLink(
      {
        altKey: false,
        clientX: 10,
        clientY: 20,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        button: 1,
        preventDefault
      },
      'https://example.com/article',
      {
        worktreeId: 'wt-1',
        sourceTabId: 'tab-1',
        sourceOwner: { kind: 'local' },
        destinations: { primary: 'orca', alternate: 'system' },
        actionsEnabled: true,
        restoreFocus: vi.fn(),
        request
      }
    )

    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
    expect(openRoutedHttpLink).toHaveBeenCalledWith('https://example.com/article', {
      worktreeId: 'wt-1',
      sourceTabId: 'tab-1',
      sourceOwner: { kind: 'local' },
      modifierHeld: false,
      forceDestination: 'system',
      backgroundSystemBrowser: true
    })
  })

  it('does not consume modified middle-clicks', () => {
    const preventDefault = vi.fn()

    const handled = handleNativeChatWebLink(
      {
        altKey: false,
        clientX: 10,
        clientY: 20,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        button: 1,
        preventDefault
      },
      'https://example.com/article',
      {
        worktreeId: 'wt-1',
        sourceOwner: { kind: 'local' },
        destinations: { primary: 'system' },
        actionsEnabled: false,
        restoreFocus: vi.fn(),
        request: vi.fn()
      }
    )

    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(openRoutedHttpLink).not.toHaveBeenCalled()
  })
})
