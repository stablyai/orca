import { describe, expect, it } from 'vitest'
import {
  DEV_RULES_BLOCK_END,
  DEV_RULES_BLOCK_START,
  hasManagedDevRulesBlock,
  removeManagedBlock,
  renderDevRulesBlock,
  upsertManagedBlock
} from './managed-agent-rules-block'
import type { DevRule } from './types'

function rule(overrides: Partial<DevRule> = {}): DevRule {
  return {
    id: 'r',
    name: 'Rule',
    content: 'Do the thing.',
    enabled: true,
    scope: { type: 'global' },
    ...overrides
  }
}

describe('renderDevRulesBlock', () => {
  it('returns an empty string when there are no rules', () => {
    expect(renderDevRulesBlock([])).toBe('')
  })

  it('returns an empty string when no rule has content', () => {
    expect(renderDevRulesBlock([rule({ name: 'A', content: '' })])).toBe('')
  })

  it('wraps rules in the managed markers with a heading per rule', () => {
    const block = renderDevRulesBlock([
      rule({ name: 'Immutability', content: 'Never mutate.' }),
      rule({ id: 'r2', name: 'Tests', content: 'Write tests first.' })
    ])
    expect(block.startsWith(DEV_RULES_BLOCK_START)).toBe(true)
    expect(block.endsWith(DEV_RULES_BLOCK_END)).toBe(true)
    expect(block).toContain('## Immutability')
    expect(block).toContain('Never mutate.')
    expect(block).toContain('## Tests')
    expect(block).toContain('Write tests first.')
  })

  it('renders content without a heading when the name is empty', () => {
    const block = renderDevRulesBlock([rule({ name: '', content: 'Loose guidance.' })])
    expect(block).toContain('Loose guidance.')
    expect(block).not.toContain('## ')
  })

  it('strips a leading "#" from the name so it cannot escape the heading level', () => {
    const block = renderDevRulesBlock([rule({ name: '### Sneaky', content: 'x' })])
    expect(block).toContain('## Sneaky')
    expect(block).not.toContain('## ### Sneaky')
  })

  it('normalizes CRLF and trims content', () => {
    const block = renderDevRulesBlock([rule({ name: 'A', content: '  line1\r\nline2  ' })])
    expect(block).toContain('line1\nline2')
    expect(block).not.toContain('\r')
  })

  it('neutralizes a marker token embedded in rule content so it cannot fake the block end', () => {
    // A rule whose content contains our literal end marker must not let the
    // managed-block boundary detection match the inner token on re-sync.
    const evil = 'see <!-- ORCA-DEV-RULES:END --> then more'
    const block = renderDevRulesBlock([rule({ name: 'A', content: evil })])
    // Exactly one real START and one real END token survive (the others are
    // broken by an inserted zero-width space).
    expect(block.match(/ORCA-DEV-RULES:START/g)?.length).toBe(1)
    expect(block.match(/ORCA-DEV-RULES:END/g)?.length).toBe(1)

    // Round-trips cleanly: upsert then re-upsert is stable, with one block.
    const once = upsertManagedBlock('# Project\n', block)
    const twice = upsertManagedBlock(once, block)
    expect(twice).toBe(once)
    expect(once.match(/ORCA-DEV-RULES:START/g)?.length).toBe(1)
    // The user's text is still present (visually identical, sans the boundary risk).
    expect(once).toContain('then more')
    // Removing the block leaves no managed markers behind.
    expect(removeManagedBlock(once)).toBe('# Project\n')
  })
})

describe('upsertManagedBlock', () => {
  const block = renderDevRulesBlock([rule({ name: 'A', content: 'aaa' })])

  it('returns just the block (with trailing newline) when the file is absent', () => {
    expect(upsertManagedBlock(null, block)).toBe(`${block}\n`)
  })

  it('appends the block after existing content with one blank line', () => {
    expect(upsertManagedBlock('# Project\n\nHello.', block)).toBe(
      `# Project\n\nHello.\n\n${block}\n`
    )
  })

  it('replaces an existing managed block in place', () => {
    const first = upsertManagedBlock('# Project\n', block)
    const newBlock = renderDevRulesBlock([rule({ name: 'B', content: 'bbb' })])
    const second = upsertManagedBlock(first, newBlock)
    expect(second).toContain('## B')
    expect(second).not.toContain('## A')
    expect(second).toContain('# Project')
    // exactly one managed block remains
    expect(second.match(/ORCA-DEV-RULES:START/g)?.length).toBe(1)
  })

  it('is idempotent', () => {
    const once = upsertManagedBlock('# Project\n', block)
    const twice = upsertManagedBlock(once, block)
    expect(twice).toBe(once)
  })

  it('preserves an unrelated managed block (e.g. IJFW memory)', () => {
    const existing = [
      '# AGENTS.md',
      '',
      'Body text.',
      '',
      '<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->',
      'memory stuff',
      '<!-- IJFW-MEMORY-END -->'
    ].join('\n')
    const result = upsertManagedBlock(existing, block)
    expect(result).toContain('<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->')
    expect(result).toContain('memory stuff')
    expect(result).toContain('<!-- IJFW-MEMORY-END -->')
    expect(result).toContain('ORCA-DEV-RULES:START')
  })
})

describe('removeManagedBlock', () => {
  const block = renderDevRulesBlock([rule({ name: 'A', content: 'aaa' })])

  it('removes the managed block and keeps surrounding content', () => {
    const withBlock = upsertManagedBlock('# Project\n\nHello.', block)
    const removed = removeManagedBlock(withBlock)
    expect(removed).toBe('# Project\n\nHello.\n')
    expect(removed).not.toContain('ORCA-DEV-RULES')
  })

  it('preserves an unrelated managed block', () => {
    const existing = [
      'Body.',
      '',
      '<!-- IJFW-MEMORY-START -->',
      'mem',
      '<!-- IJFW-MEMORY-END -->'
    ].join('\n')
    const withBlock = upsertManagedBlock(existing, block)
    const removed = removeManagedBlock(withBlock)
    expect(removed).toContain('<!-- IJFW-MEMORY-START -->')
    expect(removed).not.toContain('ORCA-DEV-RULES')
  })

  it('returns an empty string when the file held only the managed block', () => {
    const onlyBlock = upsertManagedBlock(null, block)
    expect(removeManagedBlock(onlyBlock)).toBe('')
  })
})

describe('hasManagedDevRulesBlock', () => {
  it('detects the managed block', () => {
    const block = renderDevRulesBlock([rule()])
    expect(hasManagedDevRulesBlock(upsertManagedBlock(null, block))).toBe(true)
    expect(hasManagedDevRulesBlock('# Just a file')).toBe(false)
  })
})
