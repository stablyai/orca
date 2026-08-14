import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  canOpenWithSystemDefault: true,
  modifierInverts: false,
  worktreeRoot: false
}))

vi.mock('./terminal-file-open-routing', () => ({
  getTerminalFileContext: () => ({}),
  isHtmlFilePath: (filePath: string) => /\.html?$/i.test(filePath),
  isTerminalFileLinkModifierInverted: () => mocks.modifierInverts,
  mapTerminalFilePath: (filePath: string) => filePath,
  shouldOpenTerminalFileWithSystemDefault: () => mocks.canOpenWithSystemDefault,
  terminalLinkWslDistro: () => null
}))

vi.mock('./terminal-worktree-path-link', () => ({
  resolveKnownWorktreeRootPathLink: () => (mocks.worktreeRoot ? { id: 'wt-2' } : null)
}))

import { getTerminalOscLinkFileHoverHint } from './terminal-osc-link-routing'

const deps = { worktreeId: 'wt-1', worktreePath: '/repo', showActions: true }

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  mocks.canOpenWithSystemDefault = true
  mocks.modifierInverts = false
  mocks.worktreeRoot = false
})

afterEach(() => vi.unstubAllGlobals())

describe('OSC 8 file link hover hint', () => {
  // The bug: the OSC 8 hover described every target with URL copy, so a file://
  // target advertised "system browser" while the click opened it in Orca.
  it('describes a file:// target with file copy, not browser copy', () => {
    const hint = getTerminalOscLinkFileHoverHint('file:///repo/src/main.ts', deps)
    expect(hint).toBe('Click for actions, ⌘+click to open, or ⇧⌘+click for default app')
    expect(hint).not.toContain('system browser')
  })

  it('describes a bare path target the same way', () => {
    expect(getTerminalOscLinkFileHoverHint('/repo/src/main.ts', deps)).toBe(
      'Click for actions, ⌘+click to open, or ⇧⌘+click for default app'
    )
  })

  it('follows the modifier swap', () => {
    mocks.modifierInverts = true
    expect(getTerminalOscLinkFileHoverHint('file:///repo/src/main.ts', deps)).toBe(
      'Click for actions, ⌘+click for default app, or ⇧⌘+click to open in Orca'
    )
  })

  it('promises only Orca when the path has no OS default to reach', () => {
    mocks.canOpenWithSystemDefault = false
    expect(getTerminalOscLinkFileHoverHint('file:///repo/src/main.ts', deps)).toBe(
      'Click for actions or ⌘+click to open in Orca'
    )
  })

  // Why: returning null is what lets the caller fall back to the URL hint.
  it('declines http(s) and other schemes', () => {
    expect(getTerminalOscLinkFileHoverHint('https://example.com', deps)).toBeNull()
    expect(getTerminalOscLinkFileHoverHint('mailto:someone@example.com', deps)).toBeNull()
  })
})
