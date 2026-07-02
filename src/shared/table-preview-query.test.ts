import { describe, expect, it } from 'vitest'
import { buildTablePreviewSql, TABLE_PREVIEW_ROW_LIMIT } from './table-preview-query'

describe('buildTablePreviewSql', () => {
  it('quotes Postgres identifiers with double quotes', () => {
    expect(buildTablePreviewSql('postgres', 'public', 'users')).toBe(
      'SELECT * FROM "public"."users" LIMIT 100;'
    )
  })

  it('quotes MySQL identifiers with backticks', () => {
    expect(buildTablePreviewSql('mysql', 'app', 'orders')).toBe(
      'SELECT * FROM `app`.`orders` LIMIT 100;'
    )
  })

  it('defaults to the shared preview row limit', () => {
    expect(buildTablePreviewSql('postgres', 'public', 'users')).toContain(
      `LIMIT ${TABLE_PREVIEW_ROW_LIMIT};`
    )
  })

  it('honors an explicit limit', () => {
    expect(buildTablePreviewSql('mysql', 'app', 'orders', 25)).toBe(
      'SELECT * FROM `app`.`orders` LIMIT 25;'
    )
  })

  it('doubles embedded quote characters so names cannot break out', () => {
    expect(buildTablePreviewSql('postgres', 'we"ird', 'ta"ble')).toBe(
      'SELECT * FROM "we""ird"."ta""ble" LIMIT 100;'
    )
    expect(buildTablePreviewSql('mysql', 'we`ird', 'ta`ble')).toBe(
      'SELECT * FROM `we``ird`.`ta``ble` LIMIT 100;'
    )
  })
})
