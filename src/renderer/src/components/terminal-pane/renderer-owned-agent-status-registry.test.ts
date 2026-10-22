import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import {
  _getRendererOwnedAgentStatusPaneCountForTest,
  isClientAuthoritativeAgentStatusPane,
  isReleasedClientWrittenAgentStatusPane,
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from './renderer-owned-agent-status-registry'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'
const ENV = 'web-env-1'
const T0 = 1_700_000_000_000

describe('renderer-owned agent status registry', () => {
  beforeEach(() => {
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it('is not authoritative until the renderer actually writes status', () => {
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
    registerRendererOwnedAgentStatusPane(PANE, ENV)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
  })

  it('ignores writes for panes that never registered', () => {
    markRendererOwnedAgentStatusWrite(OTHER_PANE)
    expect(isClientAuthoritativeAgentStatusPane(OTHER_PANE)).toBe(false)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
  })

  it('cedes authority on teardown but remembers that it wrote, until the row could not be live', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    try {
      const release = registerRendererOwnedAgentStatusPane(PANE, ENV)
      markRendererOwnedAgentStatusWrite(PANE)
      release()

      expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
      // The host publishes nothing for a pane this renderer wrote, so the mirror
      // needs the released claim to read that silence correctly (#22445).
      expect(isReleasedClientWrittenAgentStatusPane(PANE, T0 + 1_000)).toBe(true)
      expect(
        isReleasedClientWrittenAgentStatusPane(PANE, T0 + AGENT_STATUS_STALE_AFTER_MS + 1)
      ).toBe(false)
      // A post-teardown write must not resurrect the claim.
      markRendererOwnedAgentStatusWrite(PANE)
      expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)

      // The evidence is swept once it can no longer describe a live row.
      vi.setSystemTime(T0 + AGENT_STATUS_STALE_AFTER_MS + 1)
      registerRendererOwnedAgentStatusPane(OTHER_PANE, ENV)
      expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(1)
      expect(isReleasedClientWrittenAgentStatusPane(PANE, Date.now())).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the earned claim across a remount in the same environment', () => {
    registerRendererOwnedAgentStatusPane(PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    registerRendererOwnedAgentStatusPane(PANE, ENV)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(1)
  })

  it('drops the claim when the pane re-registers under another environment', () => {
    registerRendererOwnedAgentStatusPane(PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    registerRendererOwnedAgentStatusPane(PANE, 'web-env-2')
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
  })

  it('scopes authority per pane and leaks nothing for a pane that never wrote', () => {
    const releasePane = registerRendererOwnedAgentStatusPane(PANE, ENV)
    const releaseOther = registerRendererOwnedAgentStatusPane(OTHER_PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
    expect(isClientAuthoritativeAgentStatusPane(OTHER_PANE)).toBe(false)
    releasePane()
    releaseOther()
    // Only the pane that proved a byte-derived write leaves evidence behind.
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(1)
    expect(isReleasedClientWrittenAgentStatusPane(OTHER_PANE, Date.now())).toBe(false)
  })

  // A replacement mount registers before the superseded pane's dispose runs
  // (use-terminal-pane-lifecycle cleanup), and both share `${tabId}:${leafId}`.
  it('keeps the successor claim when a superseded pane releases late', () => {
    const staleRelease = registerRendererOwnedAgentStatusPane(PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    registerRendererOwnedAgentStatusPane(PANE, ENV)

    staleRelease()

    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(1)
  })
})
