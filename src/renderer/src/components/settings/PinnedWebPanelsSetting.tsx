import React from 'react'
import { Trash2 } from 'lucide-react'
import type { GlobalSettings, PinnedWebPanel } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { MAX_PINNED_WEB_PANELS } from '../../../../shared/pinned-web-panels'
import { prunePanelLayoutsForSurvivingPanels } from '../../../../shared/panel-layouts'
import { useAppStore } from '../../store'

type PinnedWebPanelsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function getPinnedWebPanelsEntry(): {
  title: string
  description: string
  keywords: string[]
} {
  return {
    title: translate('auto.components.settings.PinnedWebPanelsSetting.title', 'Pinned web panels'),
    description: translate(
      'auto.components.settings.PinnedWebPanelsSetting.description',
      'Pin dashboards (Grafana, CI, issue boards) to the sidebar as persistent pages.'
    ),
    keywords: ['pinned', 'panel', 'dashboard', 'grafana', 'webview', 'sidebar']
  }
}

export function PinnedWebPanelsSetting({
  settings,
  updateSettings
}: PinnedWebPanelsSettingProps): React.JSX.Element {
  const panels = settings.pinnedWebPanels ?? []
  const [draftTitle, setDraftTitle] = React.useState('')
  const [draftUrl, setDraftUrl] = React.useState('')

  const draftUrlValid = React.useMemo(() => {
    try {
      const parsed = new URL(draftUrl.trim())
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }, [draftUrl])

  const addPanel = (): void => {
    if (!draftUrlValid || panels.length >= MAX_PINNED_WEB_PANELS) {
      return
    }
    const panel: PinnedWebPanel = {
      id: crypto.randomUUID(),
      title: draftTitle.trim(),
      url: draftUrl.trim()
    }
    updateSettings({ pinnedWebPanels: [...panels, panel] })
    setDraftTitle('')
    setDraftUrl('')
  }

  const removePanel = (id: string): void => {
    const next = panels.filter((panel) => panel.id !== id)
    const state = useAppStore.getState()
    updateSettings({
      pinnedWebPanels: next,
      // Why: a saved layout pointing at a deleted panel renders a dead tile.
      panelLayouts: prunePanelLayoutsForSurvivingPanels(
        state.settings?.panelLayouts,
        state.settings?.pinnedTerminalPanels ?? [],
        next
      )
    })
  }

  return (
    <div className="space-y-2">
      {panels.length > 0 ? (
        <div className="divide-y divide-border/40 rounded-md border border-border/60">
          {panels.map((panel) => (
            <div key={panel.id} className="flex items-center gap-2 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{panel.title}</div>
                <div className="truncate text-[11px] text-muted-foreground">{panel.url}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={translate(
                  'auto.components.settings.PinnedWebPanelsSetting.remove',
                  'Remove panel'
                )}
                onClick={() => removePanel(panel.id)}
              >
                <Trash2 className="size-3.5" strokeWidth={1.75} />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {panels.length < MAX_PINNED_WEB_PANELS ? (
        <div className="flex items-center gap-2">
          <Input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder={translate(
              'auto.components.settings.PinnedWebPanelsSetting.titlePlaceholder',
              'Title'
            )}
            className="h-7 w-32 text-[12px]"
          />
          <Input
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addPanel()
              }
            }}
            placeholder="https://…"
            className="h-7 flex-1 text-[12px]"
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-7"
            disabled={!draftUrlValid}
            onClick={addPanel}
          >
            {translate('auto.components.settings.PinnedWebPanelsSetting.add', 'Add')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
