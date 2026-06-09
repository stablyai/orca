import type { JSX } from 'react'
import { translate } from '@/i18n/i18n'

// Why: shared between ReviewNotesAnimatedVisual / ReviewShipAnimatedVisual.
// Kept in a single module so the two pages stay aligned (same diff data,
// same icon set, same caret/cursor scaffolding).

export function CursorIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
    >
      <path
        d="M2 1.5 L2 12 L5 9 L7.2 14.5 L9.5 13.6 L7.3 8 L11.5 8 Z"
        fill="#fff"
        stroke="#18181b"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function PlusIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

export function MessageIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4h10v6H7l-3 3v-3H3z" />
    </svg>
  )
}

export function SendIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 8 14 3l-4 11-2-5-6-1z" />
    </svg>
  )
}

export function CornerEnterIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4v4a2 2 0 0 0 2 2h7M9 7l3 3-3 3" />
    </svg>
  )
}

export function CheckTinyIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}

export function ArrowUpIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 13V3m-4 4 4-4 4 4" />
    </svg>
  )
}

export function FileIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 2h5l3 3v9H4z" />
    </svg>
  )
}

export function ChevDownIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

export function ClaudeLogo(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-label={translate("auto.components.feature.wall.review.animated.visual.shared.9deecb021c", "Claude")}>
      <path
        fill="#D97757"
        fillRule="nonzero"
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
      />
    </svg>
  )
}

export function CodexLogo(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-label={translate("auto.components.feature.wall.review.animated.visual.shared.e7894927a2", "Codex")} style={{ color: '#111' }}>
      <path
        fill="currentColor"
        d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
      />
    </svg>
  )
}

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

// Why: same files appear in the SC changes list and conceptually feed both
// the commit message and the PR body, so the read→write relationship reads
// as one motion to the viewer.
export const SHIP_FILES: readonly string[] = ['migrate.ts', 'backfill-users.ts', 'migrate.test.ts']

// Lightweight tokenizer — just enough so the diff doesn't read as one solid
// color block. Quiet by design.
export function tokenize(line: string): string {
  const KW =
    /\b(?:const|let|await|function|return|if|else|for|of|in|try|catch|throw|new|export|import|from)\b/g
  const STR = /(`[^`]*`|"[^"]*"|'[^']*')/g
  let html = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  html = html.replace(STR, (m) => `<span class="ravs-tok-str">${m}</span>`)
  html = html.replace(KW, (m) => `<span class="ravs-tok-kw">${m}</span>`)
  html = html.replace(/(\b[A-Za-z_]\w*\b)(?=\()/g, (m) => `<span class="ravs-tok-id">${m}</span>`)
  return html
}

export const PANEL_WIDTH = 480
export const PANEL_HEIGHT = 416
