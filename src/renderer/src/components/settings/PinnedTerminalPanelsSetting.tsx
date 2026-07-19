import React from 'react'
import { Trash2 } from 'lucide-react'
import type { GlobalSettings, PinnedTerminalPanel } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { MAX_PINNED_TERMINAL_PANELS } from '../../../../shared/pinned-terminal-panels'
import { SearchableSetting } from './SearchableSetting'

type PinnedTerminalPanelsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function getPinnedTerminalPanelsEntry(): {
  title: string
  description: string
  keywords: string[]
} {
  return {
    title: translate(
      'auto.components.settings.PinnedTerminalPanelsSetting.title',
      'Pinned terminal panels'
    ),
    description: translate(
      'auto.components.settings.PinnedTerminalPanelsSetting.description',
      'Pin observability commands (nvtop, btop, watch …) to the sidebar as persistent terminals.'
    ),
    keywords: ['pinned', 'panel', 'terminal', 'nvtop', 'btop', 'observability', 'sidebar']
  }
}

export function PinnedTerminalPanelsSearchableSetting({
  settings,
  updateSettings,
  forceVisible
}: PinnedTerminalPanelsSettingProps & { forceVisible: boolean }): React.JSX.Element {
  const entry = getPinnedTerminalPanelsEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-2"
      forceVisible={forceVisible}
    >
      <PinnedTerminalPanelsSetting settings={settings} updateSettings={updateSettings} />
    </SearchableSetting>
  )
}

export function PinnedTerminalPanelsSetting({
  settings,
  updateSettings
}: PinnedTerminalPanelsSettingProps): React.JSX.Element {
  const panels = settings.pinnedTerminalPanels ?? []
  const [draftTitle, setDraftTitle] = React.useState('')
  const [draftCommand, setDraftCommand] = React.useState('')
  const [draftHost, setDraftHost] = React.useState('')
  const [draftGroup, setDraftGroup] = React.useState('')

  const draftCommandValid = draftCommand.trim().length > 0

  const addPanel = (): void => {
    if (!draftCommandValid || panels.length >= MAX_PINNED_TERMINAL_PANELS) {
      return
    }
    const trimmedHost = draftHost.trim()
    const panel: PinnedTerminalPanel = {
      id: crypto.randomUUID(),
      title: draftTitle.trim(),
      command: draftCommand.trim(),
      ...(trimmedHost.length > 0 ? { host: trimmedHost } : {}),
      ...(draftGroup.trim().length > 0 ? { group: draftGroup.trim() } : {})
    }
    updateSettings({ pinnedTerminalPanels: [...panels, panel] })
    setDraftTitle('')
    setDraftCommand('')
    setDraftHost('')
    setDraftGroup('')
  }

  const removePanel = (id: string): void => {
    updateSettings({ pinnedTerminalPanels: panels.filter((panel) => panel.id !== id) })
  }

  return (
    <div className="space-y-2">
      {panels.length > 0 ? (
        <div className="divide-y divide-border/40 rounded-md border border-border/60">
          {panels.map((panel) => (
            <div key={panel.id} className="flex items-center gap-2 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  {panel.group ? `${panel.group} / ` : ''}
                  {panel.title}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {panel.command}
                  {panel.host ? ` @ ${panel.host}` : ''}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={translate(
                  'auto.components.settings.PinnedTerminalPanelsSetting.remove',
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
      {panels.length < MAX_PINNED_TERMINAL_PANELS ? (
        <div className="flex items-center gap-2">
          <Input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder={translate(
              'auto.components.settings.PinnedTerminalPanelsSetting.titlePlaceholder',
              'Title'
            )}
            className="h-7 w-32 text-[12px]"
          />
          <Input
            value={draftCommand}
            onChange={(e) => setDraftCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addPanel()
              }
            }}
            placeholder="nvtop"
            className="h-7 flex-1 font-mono text-[12px]"
          />
          <Input
            value={draftGroup}
            onChange={(e) => setDraftGroup(e.target.value)}
            placeholder={translate(
              'auto.components.settings.PinnedTerminalPanelsSetting.groupPlaceholder',
              'Group'
            )}
            className="h-7 w-24 text-[12px]"
          />
          <Input
            value={draftHost}
            onChange={(e) => setDraftHost(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addPanel()
              }
            }}
            placeholder={translate(
              'auto.components.settings.PinnedTerminalPanelsSetting.hostPlaceholder',
              'SSH host (optional)'
            )}
            className="h-7 w-36 font-mono text-[12px]"
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-7"
            disabled={!draftCommandValid}
            onClick={addPanel}
          >
            {translate('auto.components.settings.PinnedTerminalPanelsSetting.add', 'Add')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
