import type React from 'react'
import type { ThemeLookPalette } from './onboarding-theme-looks'

// Why inline colors throughout: each preview paints another theme's palette, not the live tokens.

/** A tiny Orca window in one look: sidebar, tab strip, and an agent transcript as color bars. */
export function ThemeLookCardPreview({
  palette
}: {
  palette: ThemeLookPalette
}): React.JSX.Element {
  const { terminal: t } = palette
  const line = (parts: [string, string][]): React.JSX.Element => (
    <div className="flex h-[3px] gap-[3px]">
      {parts.map(([color, width], index) => (
        <span key={index} className="rounded-full" style={{ background: color, width }} />
      ))}
    </div>
  )
  return (
    <div aria-hidden="true" className="flex size-full" style={{ background: palette.background }}>
      <div
        className="flex w-[28%] shrink-0 flex-col gap-[5px] px-1.5 py-2"
        style={{ background: palette.sidebar, borderRight: `1px solid ${palette.border}` }}
      >
        {[t.green, t.yellow, palette.mutedForeground].map((dot, index) => (
          <div key={index} className="flex items-center gap-1">
            <span className="size-[4px] shrink-0 rounded-full" style={{ background: dot }} />
            <span
              className="h-[3px] rounded-full"
              style={{
                background: index === 0 ? palette.foreground : palette.mutedForeground,
                width: `${70 - index * 15}%`,
                opacity: index === 0 ? 0.85 : 0.5
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-3 shrink-0 items-end gap-1 px-1.5"
          style={{ borderBottom: `1px solid ${palette.border}` }}
        >
          <span className="h-[2px] w-5 rounded-t" style={{ background: palette.primary }} />
          <span
            className="mb-[3px] h-[2px] w-4 rounded-full"
            style={{ background: palette.border }}
          />
        </div>
        <div
          className="flex flex-1 flex-col gap-[5px] px-2 py-2"
          style={{ background: t.background }}
        >
          {line([
            [t.magenta, '8%'],
            [t.foreground, '55%']
          ])}
          {line([
            [t.blue, '8%'],
            [t.muted, '30%'],
            [t.cyan, '28%']
          ])}
          {line([
            [t.green, '42%'],
            [t.green, '18%']
          ])}
          {line([
            [t.red, '36%'],
            [t.red, '14%']
          ])}
          {line([
            [t.yellow, '8%'],
            [t.foreground, '32%']
          ])}
        </div>
      </div>
    </div>
  )
}
