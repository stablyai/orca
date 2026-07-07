import { useState } from 'react'
import { Info } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { normalizeGlobalWindowsRuntimeDefault } from '../../../../shared/project-execution-runtime'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

export type AgentSessionSourceHomeControl = {
  runtimeLabel: string
  value: string
  onSave: (value: string) => void
}

type UpdateSettings = (updates: Partial<GlobalSettings>) => void | Promise<void>

/**
 * Builds the Codex session-history source control scoped to the runtime the
 * Agents pane is showing (host or the selected WSL distro), so it mirrors how
 * detected agents are scoped. History-only: it never touches auth/config.
 */
// Why: the launch-time resolver matches distro keys case-insensitively, so the
// UI must resolve to the SAME stored key. Otherwise a casing mismatch would show
// an empty override for an active value and, on edit, create a duplicate key.
function findWslSourceHomeKey(
  wsl: Record<string, string> | undefined,
  distro: string
): string | undefined {
  const normalized = distro.trim().toLowerCase()
  return Object.keys(wsl ?? {}).find((key) => key.trim().toLowerCase() === normalized)
}

export function buildCodexSessionSourceHomeControl(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome' | 'localWindowsRuntimeDefault'>,
  updateSettings: UpdateSettings
): AgentSessionSourceHomeControl {
  const runtimeScope = normalizeGlobalWindowsRuntimeDefault(settings.localWindowsRuntimeDefault)
  const sourceHome = settings.codexSessionSourceHome
  // Why: a WSL scope with no selected distro can't target a per-distro history
  // home, so fall back to the host control rather than a null distro key.
  const wslDistro = runtimeScope.kind === 'wsl' ? runtimeScope.distro?.trim() : undefined
  if (wslDistro) {
    const existingKey = findWslSourceHomeKey(sourceHome?.wsl, wslDistro)
    return {
      runtimeLabel: `${wslDistro}: ~/.codex`,
      value: (existingKey ? sourceHome?.wsl?.[existingKey] : undefined) ?? '',
      // Save under the existing key when one matches (case-insensitively), so
      // editing updates it in place instead of adding a differently-cased key.
      onSave: (value: string) =>
        saveCodexSessionSourceHome(settings, updateSettings, {
          runtime: 'wsl',
          distro: existingKey ?? wslDistro,
          value
        })
    }
  }
  return {
    runtimeLabel: '~/.codex',
    value: sourceHome?.host ?? '',
    onSave: (value: string) =>
      saveCodexSessionSourceHome(settings, updateSettings, { runtime: 'host', value })
  }
}

function saveCodexSessionSourceHome(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>,
  updateSettings: UpdateSettings,
  args: { runtime: 'host'; value: string } | { runtime: 'wsl'; distro: string; value: string }
): void {
  const current = settings.codexSessionSourceHome ?? {}
  const trimmed = args.value.trim()
  if (args.runtime === 'host') {
    updateSettings({ codexSessionSourceHome: { ...current, host: trimmed || undefined } })
    return
  }
  const nextWsl = { ...current.wsl }
  // Why: reuse an existing case-insensitive match so we never leave a stale
  // duplicate key behind when the caller passes a differently-cased distro.
  const targetKey = findWslSourceHomeKey(nextWsl, args.distro) ?? args.distro
  if (trimmed) {
    nextWsl[targetKey] = trimmed
  } else {
    delete nextWsl[targetKey]
  }
  updateSettings({
    codexSessionSourceHome: {
      ...current,
      wsl: Object.keys(nextWsl).length > 0 ? nextWsl : undefined
    }
  })
}

export function AgentSessionSourceHomeInput({
  runtimeLabel,
  value,
  onSave
}: AgentSessionSourceHomeControl): React.JSX.Element {
  const [draft, setDraft] = useState(value)

  const commit = (): void => {
    onSave(draft.trim())
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.AgentsPane.codexSessionSource',
          'Codex home to import from'
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={translate(
                'auto.components.settings.AgentsPane.codexSessionSourceInfo',
                'About importing Codex history'
              )}
              className="grid size-4 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Info className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="max-w-xs">
            {translate(
              'auto.components.settings.AgentsPane.codexSessionSourceTooltip',
              'Orca runs Codex in an isolated home. Point this at your existing Codex home to import that session history. Empty uses ~/.codex.'
            )}
          </TooltipContent>
        </Tooltip>
      </span>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              setDraft(value)
              e.currentTarget.blur()
            }
          }}
          placeholder={runtimeLabel}
          spellCheck={false}
          className="h-7 flex-1 font-mono text-xs"
        />
        {value.trim() && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onSave('')
              setDraft('')
            }}
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
          </Button>
        )}
      </div>
    </div>
  )
}
