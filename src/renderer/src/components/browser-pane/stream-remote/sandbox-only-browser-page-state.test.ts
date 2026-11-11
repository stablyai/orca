import { describe, expect, it } from 'vitest'
import { canOpenSandboxPageOnThisComputer } from './sandbox-only-browser-page-state'

describe('canOpenSandboxPageOnThisComputer', () => {
  it('offers http(s) pages, including the sandbox localhost', () => {
    expect(canOpenSandboxPageOnThisComputer('https://example.org/')).toBe(true)
    expect(canOpenSandboxPageOnThisComputer('http://localhost:3000/x')).toBe(true)
    expect(canOpenSandboxPageOnThisComputer('http://127.0.0.1:8123/')).toBe(true)
  })

  it('keeps file:, about:, chrome: and unparsable pages in the sandbox', () => {
    expect(canOpenSandboxPageOnThisComputer('file:///tmp/report.html')).toBe(false)
    expect(canOpenSandboxPageOnThisComputer('about:blank')).toBe(false)
    expect(canOpenSandboxPageOnThisComputer('chrome://version')).toBe(false)
    expect(canOpenSandboxPageOnThisComputer('not a url')).toBe(false)
  })
})
