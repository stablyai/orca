export type DiffLine = { kind: 'ctx' | 'add' | 'rem'; t: string }
export type Hunk = {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export const HUNKS: readonly Hunk[] = [
  {
    header: '@@ -42,5 +42,7 @@ export function applyMigration(db, version) {',
    oldStart: 42,
    newStart: 42,
    lines: [
      { kind: 'ctx', t: '  const ctx = beginTx(db)' },
      { kind: 'rem', t: '    runStep(ctx, "schema", version)' },
      { kind: 'add', t: '    await runStep(ctx, "schema", version)' },
      { kind: 'add', t: '    await runStep(ctx, "backfill", version)' },
      { kind: 'ctx', t: '    commit(ctx)' }
    ]
  },
  {
    header: '@@ -88,3 +90,4 @@ function backfillUsers(rows) {',
    oldStart: 88,
    newStart: 90,
    lines: [
      { kind: 'ctx', t: '  for (const row of rows) {' },
      { kind: 'rem', t: '    db.exec(sql, row)' },
      { kind: 'add', t: '    if (!row.tier) continue' },
      { kind: 'add', t: '    db.exec(sql, [row.tier, row.id])' }
    ]
  }
]

export const NOTE_TARGETS: readonly {
  hunk: number
  lineIdx: number
  body: string
  summary: string
}[] = [
  {
    hunk: 0,
    lineIdx: 2,
    body: 'Backfill must run before commit if schema assumes new columns.',
    summary: 'Sequence schema → backfill before commit'
  },
  {
    hunk: 1,
    lineIdx: 2,
    body: 'Silently skipping rows — log the count or surface it in the result.',
    summary: 'Log skipped rows in result'
  }
]

export const COMMIT_MSG = 'Run schema + backfill steps in order during migration'
export const PR_TITLE = 'Run schema + backfill in order during migration'
export const PR_BODY =
  'Awaits schema before backfill so commits stay in order. Skips rows with no tier on reruns.'

export const SHIP_FILES: readonly string[] = ['migrate.ts', 'backfill-users.ts', 'migrate.test.ts']

export const PANEL_WIDTH = 480
export const PANEL_HEIGHT = 416
