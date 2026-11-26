import { describe, expect, it } from 'vitest'
import { hasGitHubLinkPeek } from './NativeChatGitHubLinkPeek'
import type { NativeChatLinkPeek } from './native-chat-link-peek-context'

const PR = 'https://github.com/acme/app/pull/41230'

const context = (overrides: Partial<NativeChatLinkPeek> = {}): NativeChatLinkPeek => ({
  githubRepo: null,
  githubRoutingAuthorityKey: null,
  webPreviews: null,
  ...overrides
})

// A caller drops its own tooltip exactly when the link peek shows a GitHub card, so the two never stack
// and a chip never loses both.
describe('hasGitHubLinkPeek', () => {
  it('answers no without a repo or a host to route through', () => {
    expect(hasGitHubLinkPeek(context(), PR)).toBe(false)
    // A web page preview alone is not the GitHub card.
    expect(hasGitHubLinkPeek(context({ webPreviews: { runtimeEnvironmentId: null } }), PR)).toBe(
      false
    )
  })

  it('answers yes for PRs and issues routed through the host', () => {
    const routed = context({ githubRoutingAuthorityKey: 'local' })
    expect(hasGitHubLinkPeek(routed, PR)).toBe(true)
    expect(hasGitHubLinkPeek(routed, 'https://github.com/acme/app/issues/41201')).toBe(true)
    expect(hasGitHubLinkPeek(routed, 'https://github.com/acme/app')).toBe(false)
  })
})
