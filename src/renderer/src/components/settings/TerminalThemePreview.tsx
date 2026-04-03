import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { terminalPalettePreview, type EffectiveTerminalAppearance } from '@/lib/terminal-theme'

type TerminalThemePreviewProps = {
  title: string
  description: string
  appearance: EffectiveTerminalAppearance
  dividerThicknessPx?: number
  inactivePaneOpacity?: number
  activePaneOpacity?: number
}

export function TerminalThemePreview({
  title,
  description,
  appearance,
  dividerThicknessPx = 3,
  inactivePaneOpacity = 0.9,
  activePaneOpacity = 1
}: TerminalThemePreviewProps): React.JSX.Element {
  const background =
    appearance.theme?.background ?? (appearance.mode === 'light' ? '#f8fafc' : '#09090b')
  const foreground =
    appearance.theme?.foreground ?? (appearance.mode === 'light' ? '#111827' : '#f4f4f5')
  const cursor = appearance.theme?.cursor ?? foreground
  const selection =
    appearance.theme?.selectionBackground ??
    (appearance.mode === 'light' ? 'rgba(59, 130, 246, 0.18)' : 'rgba(148, 163, 184, 0.22)')
  const palette = terminalPalettePreview(appearance.theme)

  return (
    <Card className="gap-4 overflow-hidden py-0">
      <CardHeader className="gap-1 border-b border-border/50 py-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4">
        <div className="flex items-center justify-between rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-xs">
          <div className="min-w-0">
            <p className="font-medium text-foreground">{appearance.themeName}</p>
            <p className="text-muted-foreground">
              {appearance.sourceTheme === 'system'
                ? `System mode, currently ${appearance.systemPrefersDark ? 'Dark' : 'Light'}`
                : `${appearance.mode === 'dark' ? 'Dark' : 'Light'} mode`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Divider</span>
            <span
              className="size-4 rounded-sm border border-border/50"
              style={{ backgroundColor: appearance.dividerColor }}
            />
          </div>
        </div>

        <div
          className="overflow-hidden rounded-lg border border-border/50"
          style={{ backgroundColor: appearance.dividerColor }}
        >
          <div className="flex min-h-[220px]">
            <div
              className="flex-1 p-3 font-mono text-[12px] leading-6"
              style={{ backgroundColor: background, color: foreground, opacity: activePaneOpacity }}
            >
              <div className="flex items-center gap-2 text-[11px] opacity-70">
                <span className="size-2 rounded-full bg-emerald-500" />
                <span>orca preview</span>
              </div>
              <div className="mt-3">$ git status --short</div>
              <div style={{ color: palette[1] ?? foreground }}>
                M src/renderer/src/components/Settings.tsx
              </div>
              <div style={{ color: palette[2] ?? foreground }}>
                A src/renderer/src/lib/terminal-theme.ts
              </div>
              <div className="mt-3">
                <span style={{ backgroundColor: selection }}>theme preview selected text</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span>$</span>
                <span>echo &quot;cursor&quot;</span>
                <span
                  className="inline-block h-[1.1em] w-[0.6ch] align-middle"
                  style={{ backgroundColor: cursor }}
                />
              </div>
            </div>
            <div
              className="shrink-0"
              style={{ width: `${dividerThicknessPx}px`, backgroundColor: appearance.dividerColor }}
            />
            <div
              className="w-[38%] p-3 font-mono text-[12px] leading-6"
              style={{
                backgroundColor: background,
                color: foreground,
                opacity: inactivePaneOpacity
              }}
            >
              <div className="opacity-70">palette</div>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {(palette.length ? palette : [foreground]).map((swatch, index) => (
                  <div
                    key={`${swatch}-${index}`}
                    className="h-6 rounded-sm border border-black/10"
                    style={{ backgroundColor: swatch }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
