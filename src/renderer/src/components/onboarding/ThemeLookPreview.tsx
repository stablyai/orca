import type React from 'react'
import type { ThemeLookPalette } from './onboarding-theme-looks'

// Why inline colors throughout: each preview paints another theme's palette, not the live tokens.

/** The look's background and four signature terminal colors, for list rows. */
export function ThemeLookSwatch({ palette }: { palette: ThemeLookPalette }): React.JSX.Element {
  const { terminal: t } = palette
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-10 shrink-0 overflow-hidden rounded-[4px] border border-border"
    >
      {[t.background, t.magenta, t.green, t.blue, t.yellow].map((color, index) => (
        <span key={index} className="flex-1" style={{ background: color }} />
      ))}
    </span>
  )
}

/** A legible Orca window in one look: the step's live preview. */
export function ThemeLookHero({
  palette,
  labels
}: {
  palette: ThemeLookPalette
  labels: {
    workspaces: string
    agentPrompt: string
    agentRead: string
    agentEdited: string
    agentDone: string
    statusMode: string
  }
}): React.JSX.Element {
  const { terminal: t } = palette
  return (
    <div
      aria-hidden="true"
      className="flex size-full overflow-hidden font-mono text-xs leading-[1.65]"
      style={{ background: palette.background, color: palette.foreground }}
    >
      <div
        className="flex w-[28%] min-w-[8.5rem] shrink-0 flex-col gap-1 px-2.5 py-3 font-sans text-[11px]"
        style={{ background: palette.sidebar, borderRight: `1px solid ${palette.border}` }}
      >
        <div
          className="mb-1 text-[9.5px] font-semibold uppercase tracking-wider"
          style={{ color: palette.mutedForeground }}
        >
          {labels.workspaces}
        </div>
        {[
          { name: 'feat/themes', dot: t.green, active: true },
          { name: 'fix/flaky-test', dot: t.yellow, active: false },
          { name: 'main', dot: palette.mutedForeground, active: false }
        ].map((row) => (
          <div
            key={row.name}
            className="flex items-center gap-2 truncate rounded-md px-2 py-1"
            style={{
              background: row.active ? palette.accent : 'transparent',
              color: row.active ? palette.foreground : palette.mutedForeground
            }}
          >
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: row.dot }} />
            <span className="truncate">{row.name}</span>
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-8 shrink-0 items-end gap-1 px-2 font-sans text-[11px]"
          style={{ borderBottom: `1px solid ${palette.border}` }}
        >
          <span
            className="rounded-t-md px-3 py-1.5"
            style={{
              background: t.background,
              color: t.foreground,
              boxShadow: `inset 0 2px 0 ${palette.primary}`
            }}
          >
            claude
          </span>
          <span className="px-3 py-1.5" style={{ color: palette.mutedForeground }}>
            README.md
          </span>
        </div>
        <div
          className="flex flex-1 flex-col overflow-hidden px-3.5 py-3"
          style={{ background: t.background, color: t.foreground }}
        >
          <div>
            <span style={{ color: t.magenta }}>❯</span> {labels.agentPrompt}
          </div>
          <div style={{ color: t.muted }}>
            <span style={{ color: t.blue }}>●</span> {labels.agentRead}{' '}
            <span style={{ color: t.cyan }}>Appearance.tsx</span>
          </div>
          <div style={{ color: t.muted }}>
            <span style={{ color: t.green }}>●</span> {labels.agentEdited}
          </div>
          <div className="pl-3" style={{ color: t.green }}>
            + applyTheme(look)
          </div>
          <div className="pl-3" style={{ color: t.green }}>
            + paintPreview(palette)
          </div>
          <div className="pl-3" style={{ color: t.red }}>
            - setTheme(&apos;dark&apos;)
          </div>
          <div>
            <span style={{ color: t.green }}>✓</span>{' '}
            <span style={{ color: t.foreground }}>{labels.agentDone}</span>{' '}
            <span style={{ color: t.yellow }}>2.1s</span>
          </div>
          <div>
            <span style={{ color: t.magenta }}>❯</span>{' '}
            <span
              className="inline-block h-3 w-1.5 translate-y-0.5"
              style={{ background: t.foreground }}
            />
          </div>
          <div
            className="mt-auto flex items-center gap-3 truncate pt-2 text-[11px]"
            style={{
              borderTop: `1px solid color-mix(in srgb, ${t.muted} 30%, transparent)`,
              color: t.muted
            }}
          >
            <span style={{ color: t.magenta }}>⏵⏵ {labels.statusMode}</span>
            <span>feat/themes</span>
            <span className="ml-auto" style={{ color: t.green }}>
              +2 −1
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
