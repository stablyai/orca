import type { RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import {
  agentEditorFieldLabel,
  type CustomAgentEditorFieldError,
  type CustomAgentEditorFormError
} from './custom-agent-editor-copy'

// The DOM id each summary link focuses. Env errors focus the whole section
// (individual rows have no stable id across add/remove).
function controlIdForField(field: CustomAgentEditorFieldError['field']): string {
  switch (field) {
    case 'label':
      return 'custom-agent-name'
    case 'commandOverride':
      return 'custom-agent-executable'
    case 'args':
      return 'custom-agent-args'
    case 'env':
      return 'custom-agent-env-section'
  }
}

type CustomAgentErrorSummaryProps = {
  fieldErrors: readonly CustomAgentEditorFieldError[]
  formError: CustomAgentEditorFormError | null
  summaryRef: RefObject<HTMLDivElement | null>
}

/** Post-submit error summary. It is focused when a submit fails (plan 991) and
 *  its links move focus to the offending control so keyboard users reach it. */
export function CustomAgentErrorSummary({
  fieldErrors,
  formError,
  summaryRef
}: CustomAgentErrorSummaryProps): React.JSX.Element | null {
  if (fieldErrors.length === 0 && !formError) {
    return null
  }
  return (
    <div
      ref={summaryRef}
      tabIndex={-1}
      role="alert"
      className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm outline-none"
    >
      {formError ? (
        <p className="font-medium text-destructive">{formError.message}</p>
      ) : (
        <>
          <p className="font-medium text-destructive">
            {translate(
              'auto.components.settings.CustomAgentEditorDialog.errorSummaryHeading',
              'Fix the following before saving:'
            )}
          </p>
          <ul className="space-y-0.5">
            {fieldErrors.map((error, index) => (
              <li key={`${error.field}-${error.envEntryIndex ?? 'all'}-${index}`}>
                <button
                  type="button"
                  className="text-left text-destructive underline-offset-2 hover:underline"
                  onClick={() => document.getElementById(controlIdForField(error.field))?.focus()}
                >
                  {agentEditorFieldLabel(error.field)}: {error.message}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
