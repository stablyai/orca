import { describe, expect, it } from 'vitest'
import { canOpenSandboxPageOnThisComputer } from './sandbox-only-browser-page-state'
import { resolveScreencastSupport } from './use-sandbox-only-browser-page'

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

describe('resolveScreencastSupport', () => {
  it('treats a pending or failed probe as no screencast on Orca Cloud', () => {
    expect(resolveScreencastSupport('pending', true)).toBe(false)
    expect(resolveScreencastSupport('failed', true)).toBe(false)
    expect(resolveScreencastSupport(false, true)).toBe(false)
    // A future orcad that streams is honoured once proven.
    expect(resolveScreencastSupport(true, true)).toBe(true)
  })

  it('keeps other hosts on the stream path until the probe says otherwise', () => {
    expect(resolveScreencastSupport('pending', false)).toBe(null)
    expect(resolveScreencastSupport('failed', false)).toBe(null)
    expect(resolveScreencastSupport(true, false)).toBe(true)
    expect(resolveScreencastSupport(false, false)).toBe(false)
  })
})
