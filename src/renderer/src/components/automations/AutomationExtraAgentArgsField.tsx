import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import {
  getExtraAgentArgsPlaceholder,
  hasExtraAgentArgs,
  supportsExtraAgentArgs
} from '../../../../shared/agent-launch/startup/automation-extra-agent-args'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from './automation-page-parts'
import {
  draftExtraAgentArgsNeedFreshSession,
  getDraftExtraAgentArgsError
} from './automation-draft-model'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationExtraAgentArgsFieldProps = {
  draft: AutomationDraft
  disabled?: boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationExtraAgentArgsField({
  draft,
  disabled,
  onDraftChange
}: AutomationExtraAgentArgsFieldProps): React.JSX.Element {
  const t = useTranslate()
  const supported = supportsExtraAgentArgs(draft.agentId)
  const error = getDraftExtraAgentArgsError(draft)
  const needsFreshSession = supported && draftExtraAgentArgsNeedFreshSession(draft)
  const inputId = useId()
  const messageId = useId()
  return (
    <div>
      <div className={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}>
        {t('auto.components.automations.extraAgentArgs.advanced', 'Advanced')}
      </div>
      <div className="mt-2 space-y-1.5">
        <label htmlFor={inputId} className="block text-xs text-muted-foreground">
          {t('auto.components.automations.extraAgentArgs.label', 'Extra agent arguments')}
        </label>
        <Textarea
          id={inputId}
          variant="code"
          value={draft.extraAgentArgs}
          spellCheck={false}
          disabled={disabled || !supported}
          aria-invalid={Boolean(error) || needsFreshSession}
          aria-describedby={messageId}
          placeholder={getExtraAgentArgsPlaceholder(draft.agentId)}
          onChange={(event) => {
            const value = event.target.value
            onDraftChange((current) => ({ ...current, extraAgentArgs: value }))
          }}
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
              {t('auto.components.automations.extraAgentArgs.clear', 'Clear arguments')}
            </Button>
          ) : null}
          {needsFreshSession ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-destructive">
                {t(
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
                {t(
                  'auto.components.automations.extraAgentArgs.useFreshSessions',
                  'Use fresh sessions'
                )}
              </Button>
            </div>
          ) : null}
          {supported || !error ? (
            <p className="text-[11px] text-muted-foreground">
              {supported
                ? t(
                    'auto.components.automations.extraAgentArgs.helper',
                    "Added to this host's default arguments for each fresh session."
                  )
                : t(
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
