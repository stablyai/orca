import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_THEME_DARK } from './terminal-theme-selection'
import { TERMINAL_THEME_CATALOG } from './terminal-themes'
import {
  ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS,
  _resetPtyOwnerHostColorsForTest,
  getPtyOwnerColorsForWorktree,
  isPtyOwnerProjectMapKnown,
  normalizeColorQueryReplyColors,
  normalizeRepoColorQueryReplyColors,
  resolvePtyOwnerColorQueryColors,
  setPtyOwnerColors,
  setPtyOwnerHostColors
} from './pty-owner-color-query-colors'
import { parsePtySessionId } from './pty-session-id-format'
import { getTerminalThemeRepoId } from './repo-terminal-theme'
import { PtyOwnerColorQueryReplies } from './pty-owner-color-query-replies'
import { parsePtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { TerminalOscColorQueryReplyColors } from './terminal-osc-color-reply'

afterEach(() => {
  _resetPtyOwnerHostColorsForTest()
})

it("falls back to the colours of Orca's default dark terminal theme", () => {
  const theme = TERMINAL_THEME_CATALOG[DEFAULT_TERMINAL_THEME_DARK]
  expect(ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS).toEqual({
    foreground: theme?.foreground,
    background: theme?.background
  })
})

it('prefers host colours, then spawn colours, then the default, skipping unusable pairs', () => {
  const host = { foreground: '#000000', background: '#111111' }
  const spawn = { foreground: '#222222', background: '#333333' }
  const unusable = { foreground: 'red', background: '#333333' }

  expect(resolvePtyOwnerColorQueryColors(host, spawn)).toEqual(host)
  expect(resolvePtyOwnerColorQueryColors(null, spawn)).toEqual(spawn)
  expect(resolvePtyOwnerColorQueryColors(unusable, spawn)).toEqual(spawn)
  expect(resolvePtyOwnerColorQueryColors(null, unusable)).toBe(
    ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS
  )
  expect(resolvePtyOwnerColorQueryColors(undefined, {})).toBe(ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS)
})

it('keeps only a wire pair that answers both slots', () => {
  expect(
    normalizeColorQueryReplyColors({ foreground: '#fff', background: 'rgb(1, 2, 3)' })
  ).toEqual({ foreground: '#fff', background: 'rgb(1, 2, 3)' })
  expect(normalizeColorQueryReplyColors({ foreground: '#fff' })).toBeNull()
  expect(normalizeColorQueryReplyColors({ foreground: '#fff', background: 'blue' })).toBeNull()
  expect(normalizeColorQueryReplyColors('#fff')).toBeNull()
  expect(normalizeColorQueryReplyColors(null)).toBeNull()
})

it("answers a themed project's worktrees from its colours and everything else from the host's", () => {
  const host = { foreground: '#000000', background: '#ffffff' }
  const project = { foreground: '#839496', background: '#002b36' }
  expect(isPtyOwnerProjectMapKnown()).toBe(false)
  setPtyOwnerColors({ colors: host, byRepoId: { 'repo-a': project } })

  expect(getPtyOwnerColorsForWorktree('repo-a::/src/a')).toEqual(project)
  expect(getPtyOwnerColorsForWorktree('repo-b::/src/b')).toEqual(host)
  expect(getPtyOwnerColorsForWorktree('folder:repo-a')).toEqual(host)
  expect(getPtyOwnerColorsForWorktree(undefined)).toEqual(host)

  expect(isPtyOwnerProjectMapKnown()).toBe(true)
  // A push without a map keeps it; a malformed map keeps it too; an empty map clears it.
  setPtyOwnerColors({ colors: host })
  setPtyOwnerColors({ colors: host, byRepoId: 'repo-a' })
  expect(getPtyOwnerColorsForWorktree('repo-a::/src/a')).toEqual(project)
  setPtyOwnerColors({ colors: host, byRepoId: {} })
  expect(getPtyOwnerColorsForWorktree('repo-a::/src/a')).toEqual(host)
})

it('drops unusable project entries and cannot be steered by a __proto__ repo id', () => {
  const project = { foreground: '#839496', background: '#002b36' }
  const normalized = normalizeRepoColorQueryReplyColors(
    JSON.parse('{"__proto__":{"foreground":"#fff","background":"#000"},"a":{"foreground":"red"}}')
  )

  expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype)
  expect(Object.keys(normalized ?? {})).toEqual(['__proto__'])
  expect(normalizeRepoColorQueryReplyColors({ b: project })).toEqual({ b: project })
  expect(normalizeRepoColorQueryReplyColors(['a'])).toBeNull()
})

describe('what one PTY answers before and after the owner learns its project', () => {
  const GLOBAL = { foreground: '#2e3434', background: '#ffffff' }
  const PROJECT = { foreground: '#839496', background: '#002b36' }
  const GLOBAL_BG = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
  const PROJECT_BG = '\x1b]11;rgb:0000/2b2b/3636\x1b\\'
  const spawn = (colors: TerminalOscColorQueryReplyColors) =>
    parsePtyStartupIngressIntent({ colors, deadlineMs: 5_000 })
  const forWorktree = (worktreeId: string) => () => getPtyOwnerColorsForWorktree(worktreeId)

  it('answers the project colours the pane spawned with until the project map arrives', () => {
    // main seeds host colours before any project map; the pane already paints its project theme.
    setPtyOwnerHostColors(GLOBAL)
    const replies = new PtyOwnerColorQueryReplies(spawn(PROJECT), forWorktree('repo-a::/src/a'))
    expect(replies.replies([11])).toEqual([PROJECT_BG])

    setPtyOwnerColors({ colors: GLOBAL, byRepoId: { 'repo-a': PROJECT } })
    expect(replies.replies([11])).toEqual([PROJECT_BG])
  })

  it('keeps an app-set colour when the map arrives with the colours the pane spawned with', () => {
    setPtyOwnerHostColors(GLOBAL)
    const replies = new PtyOwnerColorQueryReplies(spawn(PROJECT), forWorktree('repo-a::/src/a'))
    replies.observe('\x1b]11;#111111\x07')

    setPtyOwnerColors({ colors: GLOBAL, byRepoId: { 'repo-a': PROJECT } })
    // The pane painted the project theme from spawn and never re-themed, so #111111 still shows.
    expect(replies.replies([11])).toEqual(['\x1b]11;rgb:1111/1111/1111\x1b\\'])
  })

  it('retires the spawn colours once the host re-themes, so the change reaches the pane', () => {
    setPtyOwnerHostColors(GLOBAL)
    const replies = new PtyOwnerColorQueryReplies(spawn(GLOBAL), forWorktree('repo-b::/src/b'))
    const dark = { foreground: '#ffffff', background: '#000000' }
    setPtyOwnerHostColors(dark)
    expect(replies.replies([11])).toEqual(['\x1b]11;rgb:0000/0000/0000\x1b\\'])
    // Back to the colours it spawned with: still the host's word, not the stale spawn snapshot.
    setPtyOwnerHostColors(GLOBAL)
    expect(replies.replies([11])).toEqual([GLOBAL_BG])
  })

  it('answers the host colours once the owner knows the project is unthemed', () => {
    setPtyOwnerHostColors(GLOBAL)
    const replies = new PtyOwnerColorQueryReplies(spawn(PROJECT), forWorktree('repo-a::/src/a'))
    setPtyOwnerColors({ colors: GLOBAL, byRepoId: {} })
    expect(replies.replies([11])).toEqual([GLOBAL_BG])
    // Known once is known for good: a push without a map keeps the empty map.
    setPtyOwnerColors({ colors: GLOBAL })
    expect(replies.replies([11])).toEqual([GLOBAL_BG])
  })

  it('keeps an app-set colour across unrelated project and host pushes', () => {
    setPtyOwnerColors({ colors: GLOBAL, byRepoId: { 'repo-a': PROJECT } })
    const replies = new PtyOwnerColorQueryReplies(undefined, forWorktree('repo-a::/src/a'))
    replies.observe('\x1b]11;#111111\x07')
    setPtyOwnerColors({
      colors: { foreground: '#000000', background: '#000000' },
      byRepoId: { 'repo-a': PROJECT, 'repo-b': GLOBAL }
    })
    expect(replies.replies([11])).toEqual(['\x1b]11;rgb:1111/1111/1111\x1b\\'])
  })

  it('answers the host colours an owner told nothing at spawn learns later', () => {
    const replies = new PtyOwnerColorQueryReplies(spawn(PROJECT), forWorktree('repo-a::/src/a'))
    expect(replies.replies([11])).toEqual([PROJECT_BG])
    setPtyOwnerHostColors(GLOBAL)
    expect(replies.replies([11])).toEqual([GLOBAL_BG])
  })
})

describe('theme repo recovered from a PTY session id', () => {
  it.each([
    ['repo-a::/Users/x/foo@@bar@@abcd1234', 'repo-a'],
    ['repo-a::/Users/x/path::with::colons@@abcd1234', 'repo-a'],
    ['repo-a::/Users/x/ends-with-at@@@abcd1234', 'repo-a'],
    ['repo-a::C:\\Users\\x\\repo@@abcd1234', 'repo-a'],
    ['repo-a::\\\\wsl.localhost\\Ubuntu\\home\\x\\repo@@abcd1234', 'repo-a'],
    ['repo-a::/Users/x/folder::workspace:0f8fad5b-d9cb-469f-a165-70867728950e@@abcd1234', 'repo-a'],
    ['folder:0f8fad5b-d9cb-469f-a165-70867728950e@@abcd1234', null],
    ['0f8fad5b', null],
    ['0f8fad5b-d9cb-469f-a165-70867728950e', null],
    ['7', null]
  ])('%s -> %s', (sessionId, repoId) => {
    expect(getTerminalThemeRepoId(parsePtySessionId(sessionId).worktreeId)).toBe(repoId)
  })
})
