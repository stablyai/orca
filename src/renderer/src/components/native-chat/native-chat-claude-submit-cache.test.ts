import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentResolvesSubmitKeybinding,
  getClaudeSubmitBytes,
  primeClaudeSubmit,
  primeComposerSubmitBytes,
  resetClaudeSubmitBytesCacheForTests,
  resolveComposerSubmitBytes
} from './native-chat-claude-submit-cache'
import {
  CLAUDE_SUBMIT_ALT_ENTER,
  CLAUDE_SUBMIT_ENTER
} from './native-chat-claude-submit-keybinding'

const readClaudeKeybindings = vi.fn()

const remappedConfig = JSON.stringify({
  bindings: [{ context: 'Chat', bindings: { enter: 'chat:newline', 'meta+enter': 'chat:submit' } }]
})

describe('claude submit bytes cache', () => {
  beforeEach(() => {
    readClaudeKeybindings.mockReset()
    resetClaudeSubmitBytesCacheForTests()
    vi.stubGlobal('window', { api: { nativeChat: { readClaudeKeybindings } } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetClaudeSubmitBytesCacheForTests()
  })

  it('defaults to Enter until the keybindings load', () => {
    readClaudeKeybindings.mockReturnValue(new Promise(() => {}))
    primeClaudeSubmit()
    expect(getClaudeSubmitBytes()).toBe(CLAUDE_SUBMIT_ENTER)
  })

  it('caches the resolved submit gesture once loaded', async () => {
    readClaudeKeybindings.mockResolvedValue(remappedConfig)
    primeClaudeSubmit()
    await vi.waitFor(() => expect(getClaudeSubmitBytes()).toBe(CLAUDE_SUBMIT_ALT_ENTER))
  })

  it('falls back to Enter when the read rejects', async () => {
    readClaudeKeybindings.mockRejectedValue(new Error('unreadable'))
    primeClaudeSubmit()
    await vi.waitFor(() => expect(readClaudeKeybindings).toHaveBeenCalledOnce())
    expect(getClaudeSubmitBytes()).toBe(CLAUDE_SUBMIT_ENTER)
  })

  it('reads the keybindings only once across repeated primes', async () => {
    readClaudeKeybindings.mockResolvedValue(remappedConfig)
    primeClaudeSubmit()
    await vi.waitFor(() => expect(getClaudeSubmitBytes()).toBe(CLAUDE_SUBMIT_ALT_ENTER))
    primeClaudeSubmit()
    primeClaudeSubmit()
    expect(readClaudeKeybindings).toHaveBeenCalledOnce()
  })
})

describe('resolveComposerSubmitBytes (who is affected)', () => {
  beforeEach(() => {
    readClaudeKeybindings.mockReset()
    resetClaudeSubmitBytesCacheForTests()
    vi.stubGlobal('window', { api: { nativeChat: { readClaudeKeybindings } } })
    // Load a remapped config so any leakage to the untouched cases would show up.
    readClaudeKeybindings.mockResolvedValue(remappedConfig)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetClaudeSubmitBytesCacheForTests()
  })

  it('applies the resolved Claude gesture for a local Claude pane', async () => {
    primeClaudeSubmit()
    await vi.waitFor(() => expect(getClaudeSubmitBytes()).toBe(CLAUDE_SUBMIT_ALT_ENTER))
    expect(resolveComposerSubmitBytes('claude', false)).toBe(CLAUDE_SUBMIT_ALT_ENTER)
  })

  it('leaves Codex on the send default even with a remapped Claude config loaded', () => {
    primeClaudeSubmit()
    expect(resolveComposerSubmitBytes('codex', false)).toBeUndefined()
  })

  it('leaves a remote Claude pane on the send default (config lives on the host)', () => {
    primeClaudeSubmit()
    expect(resolveComposerSubmitBytes('claude', true)).toBeUndefined()
  })
})

describe('per-agent gating (single source of truth)', () => {
  beforeEach(() => {
    readClaudeKeybindings.mockReset()
    resetClaudeSubmitBytesCacheForTests()
    vi.stubGlobal('window', { api: { nativeChat: { readClaudeKeybindings } } })
    readClaudeKeybindings.mockResolvedValue(remappedConfig)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetClaudeSubmitBytesCacheForTests()
  })

  it('marks only Claude as resolving a submit keybinding', () => {
    expect(agentResolvesSubmitKeybinding('claude')).toBe(true)
    expect(agentResolvesSubmitKeybinding('codex')).toBe(false)
  })

  it('primes the read for a Claude composer', async () => {
    primeComposerSubmitBytes('claude')
    await vi.waitFor(() => expect(readClaudeKeybindings).toHaveBeenCalledOnce())
  })

  it('never reads keybindings for a non-Claude composer', () => {
    primeComposerSubmitBytes('codex')
    expect(readClaudeKeybindings).not.toHaveBeenCalled()
  })
})
