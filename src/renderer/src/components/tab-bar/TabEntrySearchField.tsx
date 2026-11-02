import { useMemo, useState, type ComponentProps, type RefObject } from 'react'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { Input } from '@/components/ui/input'
import { useOncePerInstallHint } from '@/hooks/use-once-per-install-hint'
import { TabAgentSearchHint } from './TabAgentSearchHint'
import {
  getTabAgentSearchHintCohort,
  type TabAgentSearchHintExperiment
} from './tab-agent-search-hint-experiment'
import { getTabAgentSearchHintExamples } from './tab-agent-search-hint-examples'
import { getTabEntryOmniboxPlaceholder } from './tab-create-entry-copy'

type Props = Omit<ComponentProps<typeof Input>, 'onChange' | 'ref'> & {
  agentPickerEntries?: readonly AgentPickerEntry[]
  eligibleForHint: boolean
  hintExperiment: TabAgentSearchHintExperiment
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
}

export function TabEntrySearchField({
  agentPickerEntries,
  eligibleForHint,
  hintExperiment,
  inputRef,
  onQueryChange,
  ...props
}: Props): React.JSX.Element {
  const [alreadyExposed] = useState(() => getTabAgentSearchHintCohort() !== null)
  const canOfferHint = eligibleForHint && props.value === '' && !props.readOnly
  const examples = useMemo(
    () =>
      !alreadyExposed && canOfferHint && agentPickerEntries
        ? getTabAgentSearchHintExamples(agentPickerEntries)
        : [],
    [agentPickerEntries, alreadyExposed, canOfferHint]
  )
  const { hintOpen, dismissHint } = useOncePerInstallHint(
    canOfferHint && examples.length > 0,
    hintExperiment.claimHint
  )
  const showHint = hintOpen && canOfferHint && examples.length > 0
  return (
    <>
      <div className="tab-entry-omnibox relative -mx-1 flex items-center px-3 text-xs text-foreground">
        <Input
          {...props}
          ref={inputRef}
          aria-label={getTabEntryOmniboxPlaceholder()}
          aria-describedby={showHint ? 'tab-agent-search-hint' : undefined}
          placeholder={getTabEntryOmniboxPlaceholder()}
          onChange={(event) => {
            dismissHint()
            onQueryChange(event.target.value)
          }}
          variant="omnibox"
          highlighted={showHint}
        />
      </div>
      {showHint ? (
        <TabAgentSearchHint
          examples={examples}
          onDismiss={() => {
            hintExperiment.trackAction('dismissed')
            dismissHint()
            inputRef.current?.focus()
          }}
          onTry={(query) => {
            hintExperiment.trackAction('try_example')
            dismissHint()
            onQueryChange(query)
            inputRef.current?.focus()
          }}
        />
      ) : null}
    </>
  )
}
