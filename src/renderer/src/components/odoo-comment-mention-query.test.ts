import { describe, expect, it } from 'vitest'

import {
  applyOdooMentionSelection,
  buildOdooMentionMarkup,
  findOdooMentionQuery,
  resolveOdooMentionMarkup
} from './odoo-comment-mention-query'

describe('findOdooMentionQuery', () => {
  it('finds the query for an @ at the start of the draft', () => {
    expect(findOdooMentionQuery('@jo', 3)).toEqual({ atIndex: 0, query: 'jo' })
  })

  it('finds the query for an @ after whitespace', () => {
    expect(findOdooMentionQuery('hey @jo', 7)).toEqual({ atIndex: 4, query: 'jo' })
  })

  it('tracks the caret position, not the end of the draft', () => {
    expect(findOdooMentionQuery('@jo more text', 3)).toEqual({ atIndex: 0, query: 'jo' })
  })

  it('returns null when there is no @ before the caret', () => {
    expect(findOdooMentionQuery('hello world', 11)).toBeNull()
  })

  it('returns null once a space closes the mention token', () => {
    expect(findOdooMentionQuery('hey @jo ', 8)).toBeNull()
  })

  it('returns an empty query right after typing @', () => {
    expect(findOdooMentionQuery('hey @', 5)).toEqual({ atIndex: 4, query: '' })
  })

  it('does not trigger on an email-like @ mid-word', () => {
    expect(findOdooMentionQuery('a@b', 3)).toBeNull()
  })
})

describe('buildOdooMentionMarkup', () => {
  it('builds the anchor markup the backend expects', () => {
    expect(buildOdooMentionMarkup({ id: 42, name: 'Jo Doe' })).toBe(
      '<a href="#" data-oe-model="res.partner" data-oe-id="42" class="o_mail_redirect">@Jo Doe</a>'
    )
  })
})

describe('applyOdooMentionSelection', () => {
  it('replaces the @query token with the plain label and a trailing space', () => {
    const result = applyOdooMentionSelection(
      'hey @jo',
      7,
      { atIndex: 4, query: 'jo' },
      { id: 1, name: 'Jo' }
    )
    expect(result.value).toBe('hey @Jo ')
    expect(result.caret).toBe(result.value.length)
  })

  it('preserves text typed after the mention token without a space before punctuation', () => {
    const result = applyOdooMentionSelection(
      'hey @jo, thanks',
      7,
      { atIndex: 4, query: 'jo' },
      { id: 1, name: 'Jo' }
    )
    expect(result.value).toBe('hey @Jo, thanks')
    expect(result.caret).toBe('hey @Jo'.length)
  })

  it('does not double a space already following the caret', () => {
    const result = applyOdooMentionSelection(
      'hey @jo team',
      7,
      { atIndex: 4, query: 'jo' },
      { id: 1, name: 'Jo' }
    )
    expect(result.value).toBe('hey @Jo team')
  })
})

describe('resolveOdooMentionMarkup', () => {
  const jo = { id: 1, name: 'Jo' }
  const joDoe = { id: 2, name: 'Jo Doe' }

  it('wraps a picked mention in the anchor markup and reports its partner id', () => {
    const result = resolveOdooMentionMarkup('hey @Jo thanks', [jo])
    expect(result.body).toBe(
      'hey <a href="#" data-oe-model="res.partner" data-oe-id="1" class="o_mail_redirect">@Jo</a> thanks'
    )
    expect(result.partnerIds).toEqual([1])
  })

  it('still resolves a mention that punctuation follows', () => {
    const result = resolveOdooMentionMarkup('hey @Jo, thanks', [jo])
    expect(result.body).toBe(
      'hey <a href="#" data-oe-model="res.partner" data-oe-id="1" class="o_mail_redirect">@Jo</a>, thanks'
    )
    expect(result.partnerIds).toEqual([1])
  })

  it('drops a mention the author deleted from the draft', () => {
    expect(resolveOdooMentionMarkup('never mind', [jo])).toEqual({
      body: 'never mind',
      partnerIds: []
    })
  })

  it('prefers the longest matching name so a short one cannot claim it', () => {
    const result = resolveOdooMentionMarkup('@Jo Doe ping', [jo, joDoe])
    expect(result.body).toBe(
      '<a href="#" data-oe-model="res.partner" data-oe-id="2" class="o_mail_redirect">@Jo Doe</a> ping'
    )
    expect(result.partnerIds).toEqual([2])
  })

  it('leaves an unpicked @word untouched', () => {
    expect(resolveOdooMentionMarkup('mail a@b and @Nobody', [jo])).toEqual({
      body: 'mail a@b and @Nobody',
      partnerIds: []
    })
  })

  it('reports one id even when the same mention appears twice', () => {
    const result = resolveOdooMentionMarkup('@Jo and @Jo', [jo])
    expect(result.partnerIds).toEqual([1])
    expect(result.body.match(/data-oe-id="1"/g)).toHaveLength(2)
  })
})
