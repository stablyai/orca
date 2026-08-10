import { describe, expect, it } from 'vitest'
import {
  GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY,
  GIT_INDEX_PRESERVING_DISCARD_UPDATE_REQUIRED_MESSAGE
} from './protocol-version'
import { assertGitIndexPreservingDiscardCapability } from './git-index-preserving-discard-capability'

describe('index-preserving discard capability', () => {
  it('accepts an authoritative capability list', () => {
    expect(() =>
      assertGitIndexPreservingDiscardCapability({
        capabilities: [GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY]
      })
    ).not.toThrow()
  })

  it.each([
    undefined,
    null,
    {},
    { capabilities: 'git.index-preserving-discard.v1' },
    {
      capabilities: [GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY, 1]
    }
  ])('rejects absent or malformed status without a mutation fallback', (status) => {
    expect(() => assertGitIndexPreservingDiscardCapability(status)).toThrow(
      GIT_INDEX_PRESERVING_DISCARD_UPDATE_REQUIRED_MESSAGE
    )
  })
})
