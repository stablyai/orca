import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isTmuxClientCommand,
  parseTmuxSocketArgs,
  resetTmuxActivePaneCacheForTests,
  resolveTmuxActivePanePid
} from './tmux-active-pane'

describe('isTmuxClientCommand', () => {
  it('recognizes plain and absolute-path tmux clients', () => {
    expect(isTmuxClientCommand('tmux attach -t work')).toBe(true)
    expect(isTmuxClientCommand('/opt/homebrew/bin/tmux a')).toBe(true)
    expect(isTmuxClientCommand('tmux')).toBe(true)
  })

  it('does not match non-tmux commands or the status-line server row', () => {
    expect(isTmuxClientCommand('claude')).toBe(false)
    expect(isTmuxClientCommand('node index.js')).toBe(false)
    expect(isTmuxClientCommand('tmuxinator start')).toBe(false)
    expect(isTmuxClientCommand('tmux: server')).toBe(false)
  })
})

describe('parseTmuxSocketArgs', () => {
  it('extracts -L and -S in separated and glued forms', () => {
    expect(parseTmuxSocketArgs('tmux -L mysock attach')).toEqual(['-L', 'mysock'])
    expect(parseTmuxSocketArgs('tmux -S /tmp/foo attach')).toEqual(['-S', '/tmp/foo'])
    expect(parseTmuxSocketArgs('tmux -Lmysock attach')).toEqual(['-L', 'mysock'])
  })

  it('returns [] for the default socket', () => {
    expect(parseTmuxSocketArgs('tmux attach -t work')).toEqual([])
    expect(parseTmuxSocketArgs('tmux')).toEqual([])
  })
})

describe('resolveTmuxActivePanePid', () => {
  beforeEach(() => resetTmuxActivePaneCacheForTests())

  it('maps a client pid to its active pane pid via list-clients', async () => {
    const runTmux = vi.fn().mockResolvedValue('999 111\n48034 48028\n1000 222\n')
    const panePid = await resolveTmuxActivePanePid(48034, 'tmux attach', { runTmux })
    expect(panePid).toBe(48028)
    expect(runTmux).toHaveBeenCalledWith(['list-clients', '-F', '#{client_pid} #{pane_pid}'])
  })

  it('passes the socket selector through to tmux', async () => {
    const runTmux = vi.fn().mockResolvedValue('42 7\n')
    await resolveTmuxActivePanePid(42, 'tmux -L work attach', { runTmux })
    expect(runTmux).toHaveBeenCalledWith([
      '-L',
      'work',
      'list-clients',
      '-F',
      '#{client_pid} #{pane_pid}'
    ])
  })

  it('returns null when the client pid is absent', async () => {
    const runTmux = vi.fn().mockResolvedValue('999 111\n')
    expect(await resolveTmuxActivePanePid(48034, 'tmux', { runTmux })).toBeNull()
  })

  it('returns null (never throws) when tmux fails', async () => {
    const runTmux = vi.fn().mockRejectedValue(new Error('no server'))
    expect(await resolveTmuxActivePanePid(1, 'tmux', { runTmux })).toBeNull()
  })

  it('serves a cached result within the TTL and refetches after it', async () => {
    const runTmux = vi.fn().mockResolvedValue('5 55\n')
    let clock = 1000
    const now = () => clock

    expect(await resolveTmuxActivePanePid(5, 'tmux', { runTmux, now })).toBe(55)
    clock += 100
    expect(await resolveTmuxActivePanePid(5, 'tmux', { runTmux, now })).toBe(55)
    expect(runTmux).toHaveBeenCalledTimes(1)

    clock += 500
    expect(await resolveTmuxActivePanePid(5, 'tmux', { runTmux, now })).toBe(55)
    expect(runTmux).toHaveBeenCalledTimes(2)
  })
})
