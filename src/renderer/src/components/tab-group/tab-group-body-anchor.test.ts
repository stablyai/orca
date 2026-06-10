import { describe, expect, it } from 'vitest'
import { tabGroupBodyAnchorName } from './tab-group-body-anchor'

describe('tabGroupBodyAnchorName', () => {
  it('returns a valid CSS custom anchor name for UUID-style group ids', () => {
    const anchorName = tabGroupBodyAnchorName('11111111-1111-4111-8111-111111111111')

    expect(anchorName).toMatch(/^--orca-tab-group-body-[0-9a-f-]+$/)
  })

  it('encodes remote runtime group ids that include path separators', () => {
    const anchorName = tabGroupBodyAnchorName(
      'headless-terminals:repo::/Users/jinwoohong/orca/workspaces/orca/branch'
    )

    expect(anchorName).not.toContain(':')
    expect(anchorName).not.toContain('/')
    expect(anchorName).toMatch(/^--orca-tab-group-body-[0-9a-f-]+$/)
  })
})
