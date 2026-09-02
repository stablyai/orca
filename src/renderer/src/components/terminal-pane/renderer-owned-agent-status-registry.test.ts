import { beforeEach, describe, expect, it } from 'vitest'
import {
  _getRendererOwnedAgentStatusPaneCountForTest,
  isClientAuthoritativeAgentStatusPane,
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from './renderer-owned-agent-status-registry'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'
const ENV = 'web-env-1'

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

  it('cedes authority on teardown and leaks no entry', () => {
    const release = registerRendererOwnedAgentStatusPane(PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    release()
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
    // A post-teardown write must not resurrect the claim.
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
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

  it('scopes authority per pane', () => {
    const releasePane = registerRendererOwnedAgentStatusPane(PANE, ENV)
    const releaseOther = registerRendererOwnedAgentStatusPane(OTHER_PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
    expect(isClientAuthoritativeAgentStatusPane(OTHER_PANE)).toBe(false)
    releasePane()
    releaseOther()
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
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
