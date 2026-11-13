import { useMemo, type ComponentProps, type RefObject } from 'react'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '@/components/ui/input'
import { useOncePerInstallHint } from '@/hooks/use-once-per-install-hint'
import { TabAgentSearchHint } from './TabAgentSearchHint'
import type { TabAgentSearchHintSession } from './tab-agent-search-hint-session'
import { getTabAgentSearchHintExamples } from './tab-agent-search-hint-examples'
import { getTabEntryOmniboxPlaceholder } from './tab-create-entry-copy'

type Props = Omit<ComponentProps<typeof Input>, 'onChange' | 'ref'> & {
  agentPickerEntries?: readonly AgentPickerEntry[]
  eligibleForHint: boolean
  hintSession: TabAgentSearchHintSession
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
}

export function TabEntrySearchField({
  agentPickerEntries,
  eligibleForHint,
  hintSession,
  inputRef,
  onQueryChange,
  ...props
}: Props): React.JSX.Element {
  const t = useTranslate()
  const canOfferHint = eligibleForHint && props.value === '' && !props.readOnly
  const examples = useMemo(
    () =>
      canOfferHint && agentPickerEntries ? getTabAgentSearchHintExamples(agentPickerEntries) : [],
    [agentPickerEntries, canOfferHint]
  )
  const { hintOpen, dismissHint } = useOncePerInstallHint(
    canOfferHint && examples.length > 0,
    hintSession.claimHint
  )
  const showHint = hintOpen && canOfferHint && examples.length > 0
  return (
    <>
      <div className="tab-entry-omnibox relative -mx-1 flex items-center px-3 text-xs text-foreground">
        <Input
          {...props}
          ref={inputRef}
          aria-label={getTabEntryOmniboxPlaceholder(t)}
          aria-describedby={showHint ? 'tab-agent-search-hint' : undefined}
          placeholder={getTabEntryOmniboxPlaceholder(t)}
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
            hintSession.trackAction('dismissed')
            dismissHint()
            inputRef.current?.focus()
          }}
          onTry={(query) => {
            hintSession.trackAction('try_example')
            dismissHint()
            onQueryChange(query)
            inputRef.current?.focus()
          }}
        />
      ) : null}
    </>
  )
}
