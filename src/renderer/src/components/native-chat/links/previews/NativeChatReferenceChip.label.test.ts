import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { isBareLabel } from './NativeChatReferenceChip'
import type { NativeChatTrackerLink } from './native-chat-tracker-links'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: label checks never read the repo.
const repo = { id: 'r' } as Repo

const pr: NativeChatTrackerLink = {
  kind: 'github',
  repo,
  ownRepo: true,
  link: { slug: { owner: 'octo', repo: 'widgets' }, number: 48, type: 'pr' }
}
const mr: NativeChatTrackerLink = {
  kind: 'gitlab',
  repo,
  link: { slug: { host: 'gitlab.com', path: 'acme/platform' }, number: 12, type: 'mr' }
}
const prHref = 'https://github.com/octo/widgets/pull/48'
const mrHref = 'https://gitlab.com/acme/platform/-/merge_requests/12'

describe('isBareLabel', () => {
  it('accepts labels that name the linked item', () => {
    for (const label of ['#48', 'PR #48', 'widgets#48', 'octo/widgets#48']) {
      expect(isBareLabel(label, prHref, pr)).toBe(true)
    }
    for (const label of ['!12', 'MR !12', 'platform!12', 'acme/platform!12']) {
      expect(isBareLabel(label, mrHref, mr)).toBe(true)
    }
  })

  it('keeps labels that name a different number, repo or marker', () => {
    for (const label of ['#49', 'gadgets#48', 'other/widgets#48', '!48']) {
      expect(isBareLabel(label, prHref, pr)).toBe(false)
    }
    for (const label of ['#12', '!13', 'other!12']) {
      expect(isBareLabel(label, mrHref, mr)).toBe(false)
    }
  })
})
