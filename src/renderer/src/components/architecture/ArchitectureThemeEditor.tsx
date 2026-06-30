import type React from 'react'
import { Palette } from 'lucide-react'
import {
  SCRYER_TAILWIND_PALETTES,
  SCRYER_THEME_COLOR_ROLES,
  type ScryerThemeSettings
} from '../../../../shared/scryer/theme'
import { Button } from '../ui/button'

type ArchitectureThemeEditorProps = {
  open: boolean
  theme: ScryerThemeSettings
  onOpenChange: (open: boolean) => void
  onThemeChange: (theme: ScryerThemeSettings) => void
}

export function ArchitectureThemeEditor({
  open,
  theme,
  onOpenChange,
  onThemeChange
}: ArchitectureThemeEditorProps): React.JSX.Element {
  const updateTheme = (patch: Partial<ScryerThemeSettings>): void =>
    onThemeChange({ ...theme, ...patch })

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="xs"
        onClick={() => onOpenChange(!open)}
        data-testid="architecture-theme-open"
      >
        <Palette className="size-3" />
        Theme
      </Button>
      {open ? (
        <div
          className="absolute right-0 top-8 z-40 grid w-[360px] gap-3 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
          data-testid="architecture-theme-editor"
        >
          <label className="grid gap-1">
            <span className="text-muted-foreground">Mode</span>
            <select
              className="rounded border border-border bg-background px-2 py-1"
              value={theme.mode}
              onChange={(event) =>
                updateTheme({ mode: event.currentTarget.value as ScryerThemeSettings['mode'] })
              }
              data-testid="architecture-theme-mode"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>

          <div className="scrollbar-sleek grid max-h-56 gap-2 overflow-y-auto pr-1">
            {SCRYER_THEME_COLOR_ROLES.map((role) => (
              <label key={role.id} className="grid grid-cols-[92px_1fr] items-center gap-2">
                <span className="truncate text-muted-foreground">{role.label}</span>
                <select
                  className="rounded border border-border bg-background px-2 py-1"
                  value={theme.paletteByRole[role.id]}
                  onChange={(event) =>
                    updateTheme({
                      paletteByRole: {
                        ...theme.paletteByRole,
                        [role.id]: event.currentTarget.value
                      }
                    })
                  }
                  data-testid={`architecture-theme-role-${role.id}`}
                >
                  {SCRYER_TAILWIND_PALETTES.map((palette) => (
                    <option key={palette.id} value={palette.id}>
                      {palette.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <span className="text-muted-foreground">Light offset</span>
              <input
                className="rounded border border-border bg-background px-2 py-1"
                type="number"
                min={-4}
                max={4}
                value={theme.lightOffset}
                onChange={(event) =>
                  updateTheme({ lightOffset: Number(event.currentTarget.value) })
                }
                data-testid="architecture-theme-light-offset"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-muted-foreground">Dark offset</span>
              <input
                className="rounded border border-border bg-background px-2 py-1"
                type="number"
                min={-4}
                max={4}
                value={theme.darkOffset}
                onChange={(event) => updateTheme({ darkOffset: Number(event.currentTarget.value) })}
                data-testid="architecture-theme-dark-offset"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <span className="text-muted-foreground">Canvas background</span>
              <input
                className="rounded border border-border bg-background px-2 py-1 font-mono"
                value={theme.canvasBackground ?? ''}
                placeholder="#f8fafc"
                onChange={(event) =>
                  updateTheme({ canvasBackground: event.currentTarget.value || undefined })
                }
                data-testid="architecture-theme-canvas-bg"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-muted-foreground">Node fill</span>
              <input
                className="rounded border border-border bg-background px-2 py-1 font-mono"
                value={theme.nodeFill ?? ''}
                placeholder="#ffffff"
                onChange={(event) =>
                  updateTheme({ nodeFill: event.currentTarget.value || undefined })
                }
                data-testid="architecture-theme-node-fill"
              />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}
