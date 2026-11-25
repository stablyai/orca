import { useState } from 'react'
import { Info } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export type AgentSessionSourceHomeControl = {
  runtimeLabel: string
  value: string
  onSave: (value: string) => void
}

type UpdateSettings = (updates: Partial<GlobalSettings>) => void | Promise<void>

// Only the host ~/.codex receives imports, so the control edits the host value under any runtime.
export function buildCodexSessionSourceHomeControl(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>,
  updateSettings: UpdateSettings
): AgentSessionSourceHomeControl {
  return {
    runtimeLabel: '~/.codex',
    value: settings.codexSessionSourceHome?.host ?? '',
    onSave: (value: string) => {
      const host = value.trim() || undefined
      updateSettings({ codexSessionSourceHome: { ...settings.codexSessionSourceHome, host } })
    }
  }
}

export function AgentSessionSourceHomeInput({
  runtimeLabel,
  value,
  onSave
}: AgentSessionSourceHomeControl): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState(value)

  const commit = (): void => {
    onSave(draft.trim())
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {t(
          'auto.components.settings.AgentsPane.codexSessionSource',
          'Import Codex conversations from'
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t(
                'auto.components.settings.AgentsPane.codexSessionSourceInfo',
                'About importing Codex conversations'
              )}
              className="grid size-4 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Info className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="max-w-xs">
            {t(
              'auto.components.settings.AgentsPane.codexSessionSourceTooltip',
              "While history is shared across accounts, Orca copies this Codex home's conversations into ~/.codex so /resume lists them. Turns added in this folder after a conversation is copied don't reach the copy."
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
          variant="code"
          className="h-7 flex-1"
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
            {t('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
          </Button>
        )}
      </div>
    </div>
  )
}
