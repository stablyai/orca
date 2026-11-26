import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { retryAgentPickerCatalog } from './agent-launch-picker-acquisition'
import { keepsRicherAgentModelListing } from '../../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

// A fast answer still spins long enough to read as a refresh.
const MIN_SPIN_MS = 400

/** Has the host list the agent's models again, for a list that came back short or stale. */
export function AgentPickerRefreshModelsButton({
  entry,
  disabled
}: {
  entry: AgentPickerEntry
  disabled?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const [clicked, setClicked] = useState(false)
  const spin = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(spin.current), [])
  const { ownerKey } = entry
  if (
    !ownerKey ||
    !entry.surfaces.length ||
    entry.catalogRead === 'unsupported' ||
    !keepsRicherAgentModelListing(entry.agent)
  ) {
    return null
  }
  const refreshing = clicked || entry.catalogRead === 'pending'
  const label = t('agentPicker.refreshModels', 'Refresh models')
  const refresh = () => {
    setClicked(true)
    clearTimeout(spin.current)
    spin.current = setTimeout(() => setClicked(false), MIN_SPIN_MS)
    retryAgentPickerCatalog(ownerKey, entry.agent, true)
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled || refreshing}
          onClick={refresh}
          // The model list picks its highlighted row on Enter; this button's keys are its own.
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              refresh()
            }
          }}
        >
          <RefreshCw className={cn(refreshing && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
