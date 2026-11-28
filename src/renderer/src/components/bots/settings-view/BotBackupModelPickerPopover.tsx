// Searchable popover picker for adding a bot backup model grouped by agent, with reasoning effort step.
import { useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotAgent } from '../../../../../shared/bot-types'
import {
  botModelTargetKey,
  type BotBackupCatalogOption
} from '../../../../../shared/bots/bot-backup-models'
import { botAgentLabel } from '../bot-presentation'

export function BotBackupModelPickerPopover({
  addableByAgent,
  canAdd,
  loading,
  onOpen,
  onSelect
}: {
  addableByAgent: readonly (readonly [BotAgent, readonly BotBackupCatalogOption[]])[]
  canAdd: boolean
  loading: boolean
  onOpen?: () => void
  onSelect: (option: BotBackupCatalogOption, effort?: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<BotAgent | null>(null)
  const [pendingOption, setPendingOption] = useState<BotBackupCatalogOption | null>(null)

  const activeAgent =
    selectedAgent && addableByAgent.some(([agent]) => agent === selectedAgent)
      ? selectedAgent
      : null
  const visibleGroups = activeAgent
    ? addableByAgent.filter(([agent]) => agent === activeAgent)
    : addableByAgent

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    setPendingOption(null)
    if (next) {
      setSelectedAgent(null)
      onOpen?.()
    }
  }

  const commitSelection = (option: BotBackupCatalogOption, effort?: string): void => {
    setOpen(false)
    setPendingOption(null)
    onSelect(option, effort)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={!canAdd && !loading}
          className="flex min-h-10 w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        >
          {loading && addableByAgent.length === 0 ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          <span>
            {loading && addableByAgent.length === 0
              ? t('settings.bots.backupModels.loadingModels', 'Loading models…')
              : t('settings.bots.backupModels.add', 'Add backup model')}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        {pendingOption?.efforts?.length ? (
          <div className="flex flex-col">
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
              <button
                type="button"
                aria-label={t('settings.bots.backupModels.backToModels', 'Back to models')}
                onClick={() => setPendingOption(null)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {pendingOption.label}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {t('settings.bots.backupModels.reasoningEffort', 'Reasoning effort')}
                </div>
              </div>
            </div>
            <div className="flex flex-col p-1">
              <button
                type="button"
                onClick={() => commitSelection(pendingOption)}
                className="flex items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span>{t('settings.bots.backupModels.defaultEffort', 'Default')}</span>
              </button>
              {pendingOption.efforts.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => commitSelection(pendingOption, choice.value)}
                  className="flex items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <span>{choice.label}</span>
                  {pendingOption.defaultEffort === choice.value ? (
                    <Badge variant="outline" className="ml-2 shrink-0">
                      {t('settings.bots.backupModels.defaultEffort', 'Default')}
                    </Badge>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Command>
            <CommandInput
              placeholder={t('settings.bots.backupModels.searchModels', 'Search models…')}
            />
            {addableByAgent.length > 1 ? (
              <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedAgent(null)}
                  className={cn(
                    'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
                    activeAgent === null
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                  )}
                >
                  {t('settings.bots.backupModels.allAgents', 'All')}
                </button>
                {addableByAgent.map(([agent]) => (
                  <button
                    key={agent}
                    type="button"
                    onClick={() => setSelectedAgent(agent)}
                    className={cn(
                      'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
                      activeAgent === agent
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )}
                  >
                    {botAgentLabel(agent)}
                  </button>
                ))}
              </div>
            ) : null}
            <CommandList>
              <CommandEmpty>
                {t('settings.bots.backupModels.noModels', 'No matching models.')}
              </CommandEmpty>
              {visibleGroups.map(([agent, options]) => (
                <CommandGroup key={agent} heading={botAgentLabel(agent)}>
                  {options.map((option) => (
                    <CommandItem
                      key={botModelTargetKey(option)}
                      value={`${botAgentLabel(option.agent)} ${option.label} ${option.model ?? ''}`}
                      onSelect={() => {
                        if (option.efforts?.length) {
                          setPendingOption(option)
                        } else {
                          commitSelection(option)
                        }
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.state === 'at-limit' ? (
                        <Badge variant="outline" className="ml-2 shrink-0">
                          {t('settings.bots.backupModels.atLimit', 'At limit')}
                        </Badge>
                      ) : option.efforts?.length ? (
                        <ChevronRight className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
