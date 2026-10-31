import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { nativeChatPreferenceFor } from '../../../../shared/structured-native-chat-launch-route'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Field, AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from './automation-page-parts'
import { automationDraftSurface } from './automation-launch-surface'
import type { AutomationDraft } from './AutomationEditorDialog'

export function AutomationSurfaceField({
  draft,
  settings,
  supported,
  onDraftChange
}: {
  draft: AutomationDraft
  settings: GlobalSettings | null
  supported: boolean | null
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element | null {
  if (supported === false && draft.surface !== 'chat') {
    return <div className="h-14" aria-hidden />
  }
  const defaultSurface = nativeChatPreferenceFor(settings, draft.agentId) ? 'chat' : 'terminal'
  const surfaces =
    defaultSurface === 'chat' ? (['terminal', 'chat'] as const) : (['chat', 'terminal'] as const)
  return (
    <Field
      className="h-14"
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={translate('components.automations.openIn', 'Open in')}
    >
      <ToggleGroup
        role="radiogroup"
        aria-label={translate('components.automations.openIn', 'Open in')}
        type="single"
        spacing={1}
        size="sm"
        variant="segmented-card"
        value={automationDraftSurface(draft, settings, supported)}
        disabled={supported === null}
        onValueChange={(surface) => {
          if (surface === 'chat' || surface === 'terminal') {
            onDraftChange((current) => ({ ...current, surface }))
          }
        }}
      >
        {surfaces.map((surface) => (
          <ToggleGroupItem
            role="radio"
            aria-checked={automationDraftSurface(draft, settings, supported) === surface}
            key={surface}
            value={surface}
            disabled={surface === 'chat' && supported !== true}
          >
            {surface === 'chat'
              ? translate('components.automations.chat', 'Chat')
              : translate('components.automations.terminal', 'Terminal')}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  )
}
