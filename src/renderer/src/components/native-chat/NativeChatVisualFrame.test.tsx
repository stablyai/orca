// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX,
  NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
  NATIVE_CHAT_VISUAL_SIZE_TYPE,
  NATIVE_CHAT_VISUAL_THEME_TYPE
} from '../../../../shared/native-chat-visual-shell'

const openHttpLink = vi.fn()
vi.mock('@/lib/http-link-routing', () => ({
  openHttpLink: (...args: unknown[]) => openHttpLink(...args)
}))

import { NativeChatVisualFrame } from './NativeChatVisualFrame'

const visual = { revision: 'r1', html: '<p>chart</p>' }

function Harness(props: { layout?: 'inline' | 'panel'; onRetired?: () => void }) {
  const scope = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={scope}>
      <NativeChatVisualFrame
        document={visual}
        title="Chart"
        layout={props.layout ?? 'inline'}
        themeScope={scope}
        onRetired={props.onRetired ?? (() => {})}
      />
    </div>
  )
}

function frameOf(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector('iframe')
  if (!frame) {
    throw new Error('no frame')
  }
  return frame
}

function channelOf(frame: HTMLIFrameElement): string {
  return frame.name.slice(NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX.length)
}

function post(data: unknown, source: MessageEventSource | null): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })
}

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { isActive, hasBeenActive: isActive }
  })
}

beforeEach(() => {
  openHttpLink.mockReset()
})

afterEach(() => {
  cleanup()
  document.documentElement.classList.remove('dark')
})

describe('NativeChatVisualFrame', () => {
  it('runs the visual in a scripts-only sandbox, named for host registration, with its CSP first', () => {
    const { container } = render(<Harness />)
    const frame = frameOf(container)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.name.startsWith(NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX)).toBe(true)
    const srcdoc = frame.getAttribute('srcdoc') ?? ''
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<p>chart</p>'))
    expect(channelOf(frame)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('fits its height to what the frame reports, ignoring other windows and channels', () => {
    const { container } = render(<Harness />)
    const frame = frameOf(container)
    const box = frame.parentElement
    const channel = channelOf(frame)
    post({ type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel, height: 420 }, frame.contentWindow)
    expect(box).toHaveStyle({ height: '420px' })
    post({ type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel, height: 900 }, window)
    post({ type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel: 'other', height: 900 }, frame.contentWindow)
    expect(box).toHaveStyle({ height: '420px' })
  })

  it('restyles in place on a theme change instead of reloading the visual', () => {
    const { container } = render(<Harness />)
    const frame = frameOf(container)
    const contentWindow = frame.contentWindow
    if (!contentWindow) {
      throw new Error('no content window')
    }
    const postMessage = vi.spyOn(contentWindow, 'postMessage')
    act(() => {
      frame.dispatchEvent(new Event('load'))
    })
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: NATIVE_CHAT_VISUAL_THEME_TYPE, colorScheme: 'light' }),
      '*'
    )
    const srcdoc = frame.getAttribute('srcdoc')
    act(() => {
      document.documentElement.classList.add('dark')
    })
    return vi.waitFor(() => {
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: NATIVE_CHAT_VISUAL_THEME_TYPE, colorScheme: 'dark' }),
        '*'
      )
      expect(frameOf(container)).toBe(frame)
      expect(frame.getAttribute('srcdoc')).toBe(srcdoc)
    })
  })

  it('opens a link only while the frame has focus and the user has just acted', () => {
    const { container } = render(<Harness />)
    const frame = frameOf(container)
    const channel = channelOf(frame)
    const link = { type: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE, channel, url: 'https://example.com/' }

    setUserActivation(true)
    post(link, frame.contentWindow)
    expect(openHttpLink).not.toHaveBeenCalled()

    frame.tabIndex = 0
    frame.focus()
    setUserActivation(false)
    post(link, frame.contentWindow)
    expect(openHttpLink).not.toHaveBeenCalled()

    setUserActivation(true)
    post(link, window)
    post({ ...link, url: 'javascript:alert(1)' }, frame.contentWindow)
    expect(openHttpLink).not.toHaveBeenCalled()

    post(link, frame.contentWindow)
    expect(openHttpLink).toHaveBeenCalledWith('https://example.com/', { forceSystemBrowser: true })
    // A burst of requests opens at most one page.
    post(link, frame.contentWindow)
    expect(openHttpLink).toHaveBeenCalledTimes(1)
  })

  it('retires itself if the frame loads a second document', () => {
    const onRetired = vi.fn()
    const { container } = render(<Harness onRetired={onRetired} />)
    const frame = frameOf(container)
    act(() => {
      frame.dispatchEvent(new Event('load'))
    })
    expect(onRetired).not.toHaveBeenCalled()
    act(() => {
      frame.dispatchEvent(new Event('load'))
    })
    expect(onRetired).toHaveBeenCalledTimes(1)
  })

  it('fills a panel instead of fitting its height', () => {
    const { container } = render(<Harness layout="panel" />)
    const frame = frameOf(container)
    post(
      { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel: channelOf(frame), height: 420 },
      frame.contentWindow
    )
    expect(frame.parentElement?.style.height).toBe('')
  })
})
