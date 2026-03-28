import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleOscLink, isTerminalLinkActivation } from './terminal-link-handlers'

const openUrlMock = vi.fn()
const openFileUriMock = vi.fn()

function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      shell: {
        openUrl: openUrlMock,
        openFileUri: openFileUriMock
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isTerminalLinkActivation', () => {
  it('requires cmd on macOS', () => {
    setPlatform('Macintosh')

    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(false)
    expect(isTerminalLinkActivation(undefined)).toBe(false)
  })

  it('requires ctrl on non-macOS platforms', () => {
    setPlatform('Windows')

    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(false)
    expect(isTerminalLinkActivation(undefined)).toBe(false)
  })
})

describe('handleOscLink', () => {
  it('opens http links only when the platform modifier is pressed', () => {
    setPlatform('Macintosh')

    handleOscLink('https://example.com', { metaKey: false, ctrlKey: false })
    expect(openUrlMock).not.toHaveBeenCalled()

    handleOscLink('https://example.com', { metaKey: true, ctrlKey: false })
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
  })

  it('opens file links only when the platform modifier is pressed', () => {
    setPlatform('Windows')

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: false })
    expect(openFileUriMock).not.toHaveBeenCalled()

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: true })
    expect(openFileUriMock).toHaveBeenCalledWith('file:///tmp/test.txt')
  })
})
