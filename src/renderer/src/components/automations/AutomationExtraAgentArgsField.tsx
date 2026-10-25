import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  getExtraAgentArgsPlaceholder,
  hasExtraAgentArgs,
  supportsExtraAgentArgs
} from '../../../../shared/automation-extra-agent-args'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from './automation-page-parts'
import {
  draftExtraAgentArgsNeedFreshSession,
  getDraftExtraAgentArgsError
} from './automation-draft-model'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationExtraAgentArgsFieldProps = {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationExtraAgentArgsField({
  draft,
  onDraftChange
}: AutomationExtraAgentArgsFieldProps): React.JSX.Element {
  const supported = supportsExtraAgentArgs(draft.agentId)
  const error = getDraftExtraAgentArgsError(draft)
  const needsFreshSession = supported && draftExtraAgentArgsNeedFreshSession(draft)
  const inputId = useId()
  const messageId = useId()
  return (
    <div>
      <div className={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}>
        {translate('auto.components.automations.extraAgentArgs.advanced', 'Advanced')}
      </div>
      <div className="mt-2 space-y-1.5">
        <label htmlFor={inputId} className="block text-xs text-muted-foreground">
          {translate('auto.components.automations.extraAgentArgs.label', 'Extra agent arguments')}
        </label>
        <Textarea
          id={inputId}
          variant="code"
          value={draft.extraAgentArgs}
          spellCheck={false}
          disabled={!supported}
          aria-invalid={Boolean(error) || needsFreshSession}
          aria-describedby={messageId}
          placeholder={getExtraAgentArgsPlaceholder(draft.agentId)}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              extraAgentArgs: event.target.value
            }))
          }
          className="min-h-14 resize-none"
        />
        <div id={messageId} className="space-y-1.5">
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {!supported && hasExtraAgentArgs(draft.extraAgentArgs) ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onDraftChange((current) => ({ ...current, extraAgentArgs: '' }))}
            >
              {translate('auto.components.automations.extraAgentArgs.clear', 'Clear arguments')}
            </Button>
          ) : null}
          {needsFreshSession ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-destructive">
                {translate(
                  'auto.components.automations.extraAgentArgs.needsFreshSession',
                  'Extra arguments require a fresh session for every run.'
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                onClick={() => onDraftChange((current) => ({ ...current, reuseSession: false }))}
              >
                {translate(
                  'auto.components.automations.extraAgentArgs.useFreshSessions',
                  'Use fresh sessions'
                )}
              </Button>
            </div>
          ) : null}
          {supported || !error ? (
            <p className="text-[11px] text-muted-foreground">
              {supported
                ? translate(
                    'auto.components.automations.extraAgentArgs.helper',
                    "Added to this host's default arguments for each fresh session."
                  )
                : translate(
                    'auto.components.automations.extraAgentArgs.unsupported',
                    "Extra arguments aren't supported for this agent yet."
                  )}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
