import { describe, expect, it } from 'vitest'
import {
  aiVaultFtsQueryIsDegraded,
  aiVaultFtsRolesForScope,
  buildAiVaultFtsMatchExpression,
  escapeAiVaultFtsLike,
  makeAiVaultLikeSnippet,
  splitAiVaultFtsQuerySegments
} from './ai-vault-session-trigram-query'

describe('ai-vault session trigram query', () => {
  it('quotes FTS terms and degrades queries shorter than 3 code points', () => {
    expect(splitAiVaultFtsQuerySegments('  二维码  useEffect( ')).toEqual(['二维码', 'useEffect('])
    expect(aiVaultFtsQueryIsDegraded(['二维码'])).toBe(false)
    expect(aiVaultFtsQueryIsDegraded(['ab'])).toBe(true)
    expect(buildAiVaultFtsMatchExpression(['二维码', 'useEffect('])).toBe(
      '"二维码" AND "useEffect("'
    )
    expect(escapeAiVaultFtsLike('100%_done')).toBe('100\\%\\_done')
  })

  it('keeps tool payloads out of Without-tools / User / Assistant role filters', () => {
    expect(aiVaultFtsRolesForScope('full')).toBeNull()
    expect(aiVaultFtsRolesForScope('fullWithoutTools')).toEqual(['user', 'assistant'])
    expect(aiVaultFtsRolesForScope('user')).toEqual(['user'])
    expect(aiVaultFtsRolesForScope('assistant')).toEqual(['assistant'])
  })

  it('builds a bounded LIKE snippet around the first segment', () => {
    const snippet = makeAiVaultLikeSnippet('prefix 二维码 suffix', '二维码')
    expect(snippet).toContain('二维码')
  })
})
