import { describe, expect, it } from 'vitest'

import {
  matchOdooInstanceIdByOrigin,
  normalizeOdooOrigin,
  parseOdooTicketLink
} from './odoo-ticket-links'

describe('parseOdooTicketLink', () => {
  it('parses a raw positive integer with no origin', () => {
    expect(parseOdooTicketLink('44779')).toEqual({ id: 44779, origin: null })
  })

  it('treats empty input as a clear (id null)', () => {
    expect(parseOdooTicketLink('   ')).toEqual({ id: null, origin: null })
  })

  it('rejects zero and non-numeric raw input', () => {
    expect(parseOdooTicketLink('0')).toEqual({ id: null, origin: null })
    expect(parseOdooTicketLink('abc')).toEqual({ id: null, origin: null })
  })

  it('extracts the id from an Odoo 17 project/task URL and keeps the origin', () => {
    expect(parseOdooTicketLink('https://acme.odoo.com/odoo/project/5/task/44779')).toEqual({
      id: 44779,
      origin: 'https://acme.odoo.com'
    })
  })

  it('extracts the id from an action route URL', () => {
    expect(parseOdooTicketLink('https://acme.odoo.com/odoo/action-project.act/312')).toEqual({
      id: 312,
      origin: 'https://acme.odoo.com'
    })
  })

  it('ignores an action route for another model', () => {
    expect(parseOdooTicketLink('https://acme.odoo.com/odoo/action-account.move/312')).toEqual({
      id: null,
      origin: null
    })
    expect(parseOdooTicketLink('acme.odoo.com/odoo/action-account.move/312')).toEqual({
      id: null,
      origin: null
    })
  })

  it('accepts the legacy web hash only when the model is project.task', () => {
    expect(
      parseOdooTicketLink('https://acme.odoo.com/web#id=44779&model=project.task&view_type=form')
    ).toEqual({ id: 44779, origin: 'https://acme.odoo.com' })
    expect(parseOdooTicketLink('https://acme.odoo.com/web#id=44779&model=res.partner')).toEqual({
      id: null,
      origin: null
    })
  })

  it('recovers an id from a protocol-less paste but reports no origin', () => {
    expect(parseOdooTicketLink('acme.odoo.com/odoo/project/5/task/7')).toEqual({
      id: 7,
      origin: null
    })
  })
})

describe('normalizeOdooOrigin', () => {
  it('lowercases the origin and drops the path', () => {
    expect(normalizeOdooOrigin('HTTPS://Acme.Odoo.com/web')).toBe('https://acme.odoo.com')
  })

  it('returns null for a non-URL', () => {
    expect(normalizeOdooOrigin('not a url')).toBeNull()
  })
})

describe('matchOdooInstanceIdByOrigin', () => {
  const instances = [
    { id: 'a', serverUrl: 'https://acme.odoo.com' },
    { id: 'b', serverUrl: 'https://other.odoo.com/' }
  ]

  it('matches an instance by normalized origin', () => {
    expect(matchOdooInstanceIdByOrigin('https://acme.odoo.com', instances)).toBe('a')
  })

  it('returns null when the origin is absent', () => {
    expect(matchOdooInstanceIdByOrigin(null, instances)).toBeNull()
  })

  it('returns null when no instance matches', () => {
    expect(matchOdooInstanceIdByOrigin('https://ghost.odoo.com', instances)).toBeNull()
  })
})

describe('parseOdooTicketLink origin contract', () => {
  it('never returns the literal string "null" for a non-special scheme', () => {
    // `new URL('mycompany:8069/...')` parses, but its origin is the string 'null'.
    const parsed = parseOdooTicketLink('mycompany:8069/odoo/project/5/task/7')
    expect(parsed.id).toBe(7)
    expect(parsed.origin).toBeNull()
  })
})
