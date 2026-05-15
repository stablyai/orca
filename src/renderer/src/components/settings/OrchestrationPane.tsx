import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SKILL_INSTALLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_STATE_EVENT,
  isOrchestrationSetupEnabled,
  isOrchestrationSkillMarkedInstalled,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { ORCHESTRATION_PANE_SEARCH_ENTRIES } from './orchestration-search'

export function OrchestrationPane(): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showOrchestration = matchesSettingsSearch(searchQuery, ORCHESTRATION_PANE_SEARCH_ENTRIES)

  const [orchestrationEnabled, setOrchestrationEnabled] = useState<boolean>(() => {
    return isOrchestrationSetupEnabled()
  })

  const [orchestrationSkillInstalled, setOrchestrationSkillInstalled] = useState<boolean>(() => {
    return isOrchestrationSkillMarkedInstalled()
  })

  useEffect(() => {
    const syncSetupState = (): void => {
      setOrchestrationEnabled(isOrchestrationSetupEnabled())
      setOrchestrationSkillInstalled(isOrchestrationSkillMarkedInstalled())
    }
    window.addEventListener(ORCHESTRATION_SETUP_STATE_EVENT, syncSetupState)
    return () => {
      window.removeEventListener(ORCHESTRATION_SETUP_STATE_EVENT, syncSetupState)
    }
  }, [])

  const toggleOrchestration = (value: boolean): void => {
    setOrchestrationEnabled(value)
    localStorage.setItem(ORCHESTRATION_ENABLED_STORAGE_KEY, value ? '1' : '0')
    notifyOrchestrationSetupStateChanged()
  }

  const markOrchestrationSkillInstalled = (value: boolean): void => {
    setOrchestrationSkillInstalled(value)
    localStorage.setItem(ORCHESTRATION_SKILL_INSTALLED_STORAGE_KEY, value ? '1' : '0')
    notifyOrchestrationSetupStateChanged()
  }

  const handleCopyOrchestrationCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(ORCHESTRATION_SKILL_INSTALL_COMMAND)
      toast.success('Copied install command. Run it on this computer.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy command.')
    }
  }

  if (!showOrchestration) {
    return <div />
  }

  return (
    <SearchableSetting
      title="Agent Orchestration"
      description="Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates."
      keywords={ORCHESTRATION_PANE_SEARCH_ENTRIES[0].keywords}
      className="space-y-3 px-1 py-2"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>Agent Orchestration</Label>
          <p className="text-xs text-muted-foreground">
            Coordinate multiple coding agents with messaging, task DAGs, dispatch with preamble
            injection, decision gates, and coordinator loops.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={orchestrationEnabled}
          onClick={() => toggleOrchestration(!orchestrationEnabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            orchestrationEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
              orchestrationEnabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {orchestrationEnabled ? (
        <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Install Orchestration Skill</p>
            <p className="text-xs text-muted-foreground">
              Run this once on your computer so agents learn to use inter-agent orchestration.
            </p>
          </div>
          <div className="flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
              {ORCHESTRATION_SKILL_INSTALL_COMMAND}
            </code>
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void handleCopyOrchestrationCommand()}
                    aria-label="Copy orchestration skill install command"
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Copy
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {orchestrationSkillInstalled
                ? 'Marked as installed on this machine.'
                : "Check off once you've run it on this computer."}
            </span>
            <button
              type="button"
              className="underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => markOrchestrationSkillInstalled(!orchestrationSkillInstalled)}
            >
              {orchestrationSkillInstalled ? 'Undo' : 'I ran it'}
            </button>
          </div>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
