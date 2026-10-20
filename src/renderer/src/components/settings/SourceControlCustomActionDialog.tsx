import { useState } from 'react'
import type React from 'react'
import { Terminal } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  MAX_SOURCE_CONTROL_CUSTOM_ACTION_LABEL_LENGTH,
  MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH,
  PULL_REQUEST_CUSTOM_ACTION_VARIABLES,
  SOURCE_CONTROL_CUSTOM_ACTION_EXAMPLE_TEMPLATE,
  type SourceControlCustomAction
} from '../../../../shared/source-control-custom-actions'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Textarea } from '../ui/textarea'
import { getSourceControlAgentArgsPlaceholder } from './source-control-action-recipe-options'
import { DEFAULT_AGENT_VALUE } from './repository-source-control-ai-labels'
import { resolveAgentArgsPlaceholderAgent } from './SourceControlActionRecipeRow'

const CUSTOM_ACTION_FORM_ID = 'source-control-custom-action-form'

export type SourceControlCustomActionDraft = {
  id: string
  label: string
  agentId: TuiAgent | null
  agentArgs: string
  commandInputTemplate: string
}

export function createSourceControlCustomActionDraft(
  action?: SourceControlCustomAction
): SourceControlCustomActionDraft {
  return {
    id: action?.id ?? createBrowserUuid(),
    label: action?.label ?? '',
    agentId: action?.agentId ?? null,
    agentArgs: action?.agentArgs ?? '',
    commandInputTemplate: action?.commandInputTemplate ?? ''
  }
}

export function sourceControlCustomActionFromDraft(
  draft: SourceControlCustomActionDraft
): SourceControlCustomAction {
  const agentArgs = draft.agentArgs.trim()
  return {
    id: draft.id,
    label: draft.label.trim(),
    commandInputTemplate: draft.commandInputTemplate.trim(),
    ...(draft.agentId ? { agentId: draft.agentId } : {}),
    ...(agentArgs ? { agentArgs } : {})
  }
}

export function isSourceControlCustomActionDraftSavable(
  draft: SourceControlCustomActionDraft
): boolean {
  const label = draft.label.trim()
  const template = draft.commandInputTemplate.trim()
  return (
    label.length > 0 &&
    label.length <= MAX_SOURCE_CONTROL_CUSTOM_ACTION_LABEL_LENGTH &&
    template.length > 0 &&
    template.length <= MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH
  )
}

export function SourceControlCustomActionDialog({
  open,
  mode,
  action,
  defaultTuiAgent,
  onOpenChange,
  onSave
}: {
  open: boolean
  mode: 'add' | 'edit'
  action: SourceControlCustomAction | null
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
  onOpenChange: (open: boolean) => void
  onSave: (action: SourceControlCustomAction) => Promise<boolean>
}): React.JSX.Element {
  // Why: the parent remounts this dialog per edit session, so the draft starts from props.
  const [draft, setDraft] = useState(() =>
    createSourceControlCustomActionDraft(action ?? undefined)
  )
  const [saving, setSaving] = useState(false)

  const canSave = !saving && isSourceControlCustomActionDraftSavable(draft)
  const templateTooLong =
    draft.commandInputTemplate.trim().length > MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH

  const save = async (): Promise<void> => {
    if (!canSave) {
      return
    }
    setSaving(true)
    try {
      if (await onSave(sourceControlCustomActionFromDraft(draft))) {
        onOpenChange(false)
      }
    } finally {
      setSaving(false)
    }
  }

  const appendVariable = (variable: string): void => {
    setDraft((current) => {
      const template = current.commandInputTemplate
      const separator = template.length === 0 || /\s$/.test(template) ? '' : ' '
      return { ...current, commandInputTemplate: `${template}${separator}{${variable}}` }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (saving ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'edit'
              ? translate('pullRequestCustomActions.dialog.editTitle', 'Edit custom action')
              : translate('pullRequestCustomActions.dialog.addTitle', 'Add custom action')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'pullRequestCustomActions.dialog.description',
              'Runs from the Start workspace menu on a pull request: Orca opens the PR workspace, starts the agent, and sends this prompt once the agent is ready.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          id={CUSTOM_ACTION_FORM_ID}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={saving} className="min-w-0 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="source-control-custom-action-label">
                {translate('pullRequestCustomActions.dialog.label', 'Label')}
              </Label>
              <Input
                id="source-control-custom-action-label"
                value={draft.label}
                maxLength={MAX_SOURCE_CONTROL_CUSTOM_ACTION_LABEL_LENGTH}
                placeholder={translate(
                  'pullRequestCustomActions.dialog.labelPlaceholder',
                  'Review'
                )}
                autoFocus
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{translate('pullRequestCustomActions.dialog.agent', 'Agent')}</Label>
                <Select
                  value={draft.agentId ?? DEFAULT_AGENT_VALUE}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      agentId:
                        value === DEFAULT_AGENT_VALUE
                          ? null
                          : (getAgentCatalog().find((agent) => agent.id === value)?.id ?? null)
                    })
                  }
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_AGENT_VALUE}>
                      <span className="flex items-center gap-2">
                        <Terminal className="size-3.5 text-muted-foreground" />
                        {translate(
                          'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
                          'Use default agent'
                        )}
                      </span>
                    </SelectItem>
                    {getAgentCatalog().map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <span className="flex items-center gap-2">
                          <AgentIcon agent={agent.id} size={14} />
                          {agent.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="source-control-custom-action-args">
                  {translate(
                    'auto.components.settings.SourceControlAiActionRecipeDefaults.2cb4bb7e5d',
                    'CLI arguments'
                  )}
                </Label>
                <Input
                  id="source-control-custom-action-args"
                  value={draft.agentArgs}
                  spellCheck={false}
                  placeholder={getSourceControlAgentArgsPlaceholder(
                    resolveAgentArgsPlaceholderAgent(draft.agentId, defaultTuiAgent)
                  )}
                  onChange={(event) => setDraft({ ...draft, agentArgs: event.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="source-control-custom-action-template">
                {translate('pullRequestCustomActions.dialog.prompt', 'Prompt')}
              </Label>
              <Textarea
                id="source-control-custom-action-template"
                variant="code"
                rows={4}
                spellCheck={false}
                value={draft.commandInputTemplate}
                placeholder={SOURCE_CONTROL_CUSTOM_ACTION_EXAMPLE_TEMPLATE}
                aria-invalid={templateTooLong || undefined}
                onChange={(event) =>
                  setDraft({ ...draft, commandInputTemplate: event.target.value })
                }
              />
              <SourceControlActionVariableChips
                variables={PULL_REQUEST_CUSTOM_ACTION_VARIABLES}
                onInsert={appendVariable}
              />
              <p className="text-[11px] text-muted-foreground">
                {translate('pullRequestCustomActions.dialog.example', 'Example: {{value0}}', {
                  value0: SOURCE_CONTROL_CUSTOM_ACTION_EXAMPLE_TEMPLATE
                })}
              </p>
            </div>
          </fieldset>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {translate('pullRequestCustomActions.dialog.cancel', 'Cancel')}
          </Button>
          <Button type="submit" form={CUSTOM_ACTION_FORM_ID} disabled={!canSave}>
            {saving
              ? translate(
                  'auto.components.settings.SourceControlAiActionRecipeDefaults.4f549a5fa8',
                  'Saving...'
                )
              : translate(
                  'auto.components.settings.SourceControlAiActionRecipeDefaults.d18d665e12',
                  'Save'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
