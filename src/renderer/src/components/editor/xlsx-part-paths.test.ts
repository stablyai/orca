import { describe, expect, it } from 'vitest'
import {
  resolveXlsxPartPath,
  resolveXlsxRelationshipTargetPath,
  resolveXlsxRelationshipsPartPath
} from './xlsx-part-paths'

describe('resolveXlsxPartPath', () => {
  it('resolves a target relative to the part that declares it', () => {
    expect(resolveXlsxPartPath('xl/workbook.xml', 'worksheets/sheet1.xml')).toBe(
      'xl/worksheets/sheet1.xml'
    )
    expect(resolveXlsxPartPath('xl/workbook.xml', 'sharedStrings.xml')).toBe('xl/sharedStrings.xml')
  })

  it('treats a leading slash as package-rooted, not filesystem-rooted', () => {
    expect(resolveXlsxPartPath('xl/workbook.xml', '/xl/worksheets/sheet1.xml')).toBe(
      'xl/worksheets/sheet1.xml'
    )
  })

  it('collapses parent and current directory segments', () => {
    expect(resolveXlsxPartPath('xl/worksheets/sheet1.xml', '../sharedStrings.xml')).toBe(
      'xl/sharedStrings.xml'
    )
    expect(resolveXlsxPartPath('xl/workbook.xml', './styles.xml')).toBe('xl/styles.xml')
    expect(resolveXlsxPartPath('xl/a/b/part.xml', '../../c/other.xml')).toBe('xl/c/other.xml')
  })

  it('does not escape the package when a target over-uses parent segments', () => {
    expect(resolveXlsxPartPath('xl/workbook.xml', '../../../etc/passwd')).toBe('etc/passwd')
  })

  it('resolves a target next to a part at the package root', () => {
    expect(resolveXlsxPartPath('workbook.xml', 'styles.xml')).toBe('styles.xml')
  })
})

describe('resolveXlsxRelationshipsPartPath', () => {
  it('places the rels part in the _rels folder beside its owner', () => {
    expect(resolveXlsxRelationshipsPartPath('xl/workbook.xml')).toBe('xl/_rels/workbook.xml.rels')
    expect(resolveXlsxRelationshipsPartPath('xl/worksheets/sheet1.xml')).toBe(
      'xl/worksheets/_rels/sheet1.xml.rels'
    )
  })

  it('handles a part at the package root', () => {
    expect(resolveXlsxRelationshipsPartPath('workbook.xml')).toBe('_rels/workbook.xml.rels')
  })
})

describe('resolveXlsxRelationshipTargetPath', () => {
  it('resolves against the owner of the relationships, not the _rels folder', () => {
    expect(
      resolveXlsxRelationshipTargetPath('xl/_rels/workbook.xml.rels', 'worksheets/sheet1.xml')
    ).toBe('xl/worksheets/sheet1.xml')
  })

  it('resolves package relationships against the package root', () => {
    expect(resolveXlsxRelationshipTargetPath('_rels/.rels', 'xl/workbook.xml')).toBe(
      'xl/workbook.xml'
    )
    expect(resolveXlsxRelationshipTargetPath('_rels/.rels', '/xl/workbook.xml')).toBe(
      'xl/workbook.xml'
    )
  })

  it('round-trips a part path through its relationships part', () => {
    const partPath = 'xl/worksheets/sheet3.xml'
    const relationshipsPartPath = resolveXlsxRelationshipsPartPath(partPath)

    expect(resolveXlsxRelationshipTargetPath(relationshipsPartPath, '../drawings/d1.xml')).toBe(
      'xl/drawings/d1.xml'
    )
  })
})
