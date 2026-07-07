import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { normalizeGlobalWindowsRuntimeDefault } from '../../../../shared/project-execution-runtime'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
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
    return {
      runtimeLabel: `${wslDistro}: ~/.codex`,
      value: sourceHome?.wsl?.[wslDistro] ?? '',
      onSave: (value: string) =>
        saveCodexSessionSourceHome(settings, updateSettings, {
          runtime: 'wsl',
          distro: wslDistro,
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
  if (trimmed) {
    nextWsl[args.distro] = trimmed
  } else {
    delete nextWsl[args.distro]
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
      <span className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.AgentsPane.codexSessionSource',
          'Codex home to import from'
        )}
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
