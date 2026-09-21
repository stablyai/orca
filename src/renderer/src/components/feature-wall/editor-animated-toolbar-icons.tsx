import type { JSX } from 'react'

// Toolbar icons mirror RichMarkdownToolbar.tsx — same families so the
// surface reads as Orca's actual editor, not a generic editor.
export const TB_ICON: Record<string, JSX.Element> = {
  pilcrow: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 3H6.5a3 3 0 0 0 0 6H8" />
      <path d="M9 3v11" />
      <path d="M12 3v11" />
    </svg>
  ),
  h1: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4v8" />
      <path d="M9 4v8" />
      <path d="M3 8h6" />
      <path d="M12 6l1-1v7" />
    </svg>
  ),
  h2: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4v8" />
      <path d="M9 4v8" />
      <path d="M3 8h6" />
      <path d="M11 6.2A1.5 1.5 0 0 1 14 6.5c0 1.4-3 2-3 5.5h3" />
    </svg>
  ),
  h3: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4v8" />
      <path d="M9 4v8" />
      <path d="M3 8h6" />
      <path d="M11 6.2A1.5 1.5 0 0 1 14 6.5c0 1.5-3 1.5-3 1.5s3 0 3 2c0 1.4-2.5 1.7-3 1" />
    </svg>
  ),
  bold: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 3h4a2.5 2.5 0 0 1 0 5H5z" />
      <path d="M5 8h4.5a2.5 2.5 0 0 1 0 5H5z" />
    </svg>
  ),
  italic: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3 6 13" />
      <path d="M5 3h5" />
      <path d="M6 13h5" />
    </svg>
  ),
  strike: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8h10" />
      <path d="M11 5a3 3 0 0 0-3-2H7a2.5 2.5 0 0 0-2.5 2.5C4.5 7 6 8 8 8" />
      <path d="M5.5 11A2.5 2.5 0 0 0 8 13h1a3 3 0 0 0 3-2.5" />
    </svg>
  ),
  list: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={3.5} cy={4} r={0.7} fill="currentColor" />
      <circle cx={3.5} cy={8} r={0.7} fill="currentColor" />
      <circle cx={3.5} cy={12} r={0.7} fill="currentColor" />
      <path d="M7 4h6" />
      <path d="M7 8h6" />
      <path d="M7 12h6" />
    </svg>
  ),
  olist: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 3h1v2.5" />
      <path d="M2 8h2c0.5 0 0.5 1 0 1l-1.5 2H4" />
      <path d="M7 4h6" />
      <path d="M7 8h6" />
      <path d="M7 12h6" />
    </svg>
  ),
  check: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x={2.5} y={2.5} width={11} height={11} rx={2} />
      <path d="m5.5 8 2 2 3-4" />
    </svg>
  ),
  quote: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 4H3v3.5L5 9V6h2V4z" />
      <path d="M11 4h-2v3.5l2 1.5V6h2V4z" />
    </svg>
  ),
  code: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 5-3 3 3 3" />
      <path d="m10 5 3 3-3 3" />
    </svg>
  ),
  copy: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x={5} y={5} width={8} height={8} rx={1.4} />
      <path d="M3 11V4a1 1 0 0 1 1-1h7" />
    </svg>
  )
}

export function ToolbarBtn(props: { iconKey: keyof typeof TB_ICON }): JSX.Element {
  return (
    <span className="inline-flex size-[22px] items-center justify-center rounded text-muted-foreground">
      <span className="size-[13px] [&>svg]:size-full">{TB_ICON[props.iconKey]}</span>
    </span>
  )
}

export function ToolbarSep(): JSX.Element {
  return <span className="mx-1 h-3.5 w-px bg-foreground/10" />
}
