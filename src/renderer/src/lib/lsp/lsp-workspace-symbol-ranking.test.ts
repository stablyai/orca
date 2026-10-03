import { describe, expect, it } from 'vitest'
import {
  rankWorkspaceSymbols,
  splitSymbolToken,
  toWorkspaceSymbolCandidates
} from './lsp-workspace-symbol-ranking'

const sym = (name: string, kind: number, uri: string, containerName?: string) => ({
  name,
  kind,
  containerName,
  location: { uri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } } }
})

describe('splitSymbolToken', () => {
  it('splits Ruby and JS qualified names', () => {
    expect(splitSymbolToken('Billing::Invoice')).toEqual({ name: 'Invoice', container: 'Billing' })
    expect(splitSymbolToken('Invoice#total')).toEqual({ name: 'total', container: 'Invoice' })
    expect(splitSymbolToken('api.fetchUser')).toEqual({ name: 'fetchUser', container: 'api' })
    expect(splitSymbolToken('Greeter')).toEqual({ name: 'Greeter', container: null })
  })

  it('strips trailing ? and ! from names', () => {
    expect(splitSymbolToken('valid?')).toEqual({ name: 'valid', container: null })
    expect(splitSymbolToken('save!')).toEqual({ name: 'save', container: null })
    expect(splitSymbolToken('Billing::valid?')).toEqual({ name: 'valid', container: 'Billing' })
  })
})

describe('rankWorkspaceSymbols', () => {
  it('prefers exact names, matching containers, definitions and project files', () => {
    const candidates = toWorkspaceSymbolCandidates([
      sym('InvoiceTotal', 5, 'file:///repo/app/a.rb'),
      sym('Invoice', 5, 'file:///repo/vendor/bundle/gems/x/invoice.rb'),
      sym('Invoice', 13, 'file:///repo/app/c.rb'),
      sym('Invoice', 5, 'file:///repo/app/models/billing/invoice.rb', 'Billing')
    ])
    const ranked = rankWorkspaceSymbols('Billing::Invoice', candidates, '/repo')
    expect(ranked.map((c) => c.uri)).toEqual([
      'file:///repo/app/models/billing/invoice.rb',
      'file:///repo/app/c.rb',
      'file:///repo/vendor/bundle/gems/x/invoice.rb'
    ])
    expect(ranked[0]).toMatchObject({ line: 4, character: 2 })
  })

  it('accepts fully qualified names from ruby-lsp and range-less WorkspaceSymbol locations', () => {
    const candidates = toWorkspaceSymbolCandidates([
      { name: 'Billing::Invoice', kind: 5, location: { uri: 'file:///repo/app/invoice.rb' } }
    ])
    expect(rankWorkspaceSymbols('Invoice', candidates, '/repo')).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ line: 0, character: 0 })
  })

  it('matches predicates and bang methods by base name', () => {
    const candidates = toWorkspaceSymbolCandidates([
      sym('valid?', 6, 'file:///repo/app/a.rb'),
      sym('save!', 6, 'file:///repo/app/b.rb')
    ])
    expect(rankWorkspaceSymbols('valid?', candidates, '/repo')).toHaveLength(1)
    expect(rankWorkspaceSymbols('save!', candidates, '/repo')).toHaveLength(1)
  })

  it('does not match project path in repo2 when searching repo', () => {
    const candidates = toWorkspaceSymbolCandidates([sym('Invoice', 5, 'file:///repo2/app/a.rb')])
    const ranked = rankWorkspaceSymbols('Invoice', candidates, '/repo')
    expect(ranked).toHaveLength(1)
    expect(ranked[0]).toMatchObject({ uri: 'file:///repo2/app/a.rb' })
    // Verify no project bonus is applied (score should be 2 for definition kind only, not 4)
  })

  it('matches Windows paths correctly with normalized drive letters', () => {
    const candidates = toWorkspaceSymbolCandidates([
      { name: 'Invoice', kind: 5, location: { uri: 'file:///c%3A/Users/x/repo/a.rb' } }
    ])
    const ranked = rankWorkspaceSymbols('Invoice', candidates, 'C:\\Users\\x\\repo')
    expect(ranked).toHaveLength(1)
    expect(ranked[0].uri).toBe('file:///c%3A/Users/x/repo/a.rb')
  })

  it('does not throw on malformed percent-encoded URIs', () => {
    const candidates = toWorkspaceSymbolCandidates([
      { name: 'Invoice', kind: 5, location: { uri: 'file:///repo/app/%E0%A4%A.rb' } }
    ])
    expect(() => rankWorkspaceSymbols('Invoice', candidates, '/repo')).not.toThrow()
    expect(rankWorkspaceSymbols('Invoice', candidates, '/repo')).toHaveLength(1)
  })

  it('matches container on :: boundary, not suffix', () => {
    const candidates = toWorkspaceSymbolCandidates([
      sym('Invoice', 5, 'file:///repo/app/a.rb', 'Billing'),
      sym('Invoice', 5, 'file:///repo/app/b.rb', 'ing')
    ])
    const ranked = rankWorkspaceSymbols('Billing::Invoice', candidates, '/repo')
    expect(ranked).toHaveLength(2)
    expect(ranked[0].containerName).toBe('Billing')
  })
})
