import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleOscLink, isTerminalLinkActivation } from './terminal-link-handlers'

const openUrlMock = vi.fn()
const openFileUriMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    value: {
      shell: {
        openUrl: openUrlMock,
        openFileUri: openFileUriMock
      }
    },
    configurable: true
  })
})

describe('isTerminalLinkActivation', () => {
  it('requires cmd on macOS', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Macintosh')

    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(false)
    expect(isTerminalLinkActivation(undefined)).toBe(false)
  })

  it('requires ctrl on non-macOS platforms', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')

    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(false)
    expect(isTerminalLinkActivation(undefined)).toBe(false)
  })
})

describe('handleOscLink', () => {
  it('opens http links only when the platform modifier is pressed', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Macintosh')

    handleOscLink('https://example.com', { metaKey: false, ctrlKey: false })
    expect(openUrlMock).not.toHaveBeenCalled()

    handleOscLink('https://example.com', { metaKey: true, ctrlKey: false })
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
  })

  it('opens file links only when the platform modifier is pressed', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: false })
    expect(openFileUriMock).not.toHaveBeenCalled()

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: true })
    expect(openFileUriMock).toHaveBeenCalledWith('file:///tmp/test.txt')
  })
})
