import type React from 'react'
import { Trash2 } from 'lucide-react'
import type { AgentSessionRule } from '../../../../shared/agent-session-rules-types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'

export function ToggleSwitch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
        checked ? 'bg-foreground' : 'bg-muted-foreground/30'
      }`}
    >
      <span
        className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

type AgentSessionRuleRowProps = {
  rule: AgentSessionRule
  dirty: boolean
  onLabelChange: (value: string) => void
  onContentChange: (value: string) => void
  onSave: () => void
  onDiscard: () => void
  onToggleEnabled: () => void
  onDelete?: () => void
}

export function AgentSessionRuleRow({
  rule,
  dirty,
  onLabelChange,
  onContentChange,
  onSave,
  onDiscard,
  onToggleEnabled,
  onDelete
}: AgentSessionRuleRowProps): React.JSX.Element {
  const editable = rule.source !== 'builtin'
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/30 p-3">
      <div className="flex items-center gap-2">
        <Input
          value={rule.label}
          disabled={!editable}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder={translate(
            'auto.components.settings.AgentSessionRuleRow.ruleLabelPlaceholder',
            'Rule name'
          )}
          className="h-8 flex-1 text-sm"
        />
        {rule.source === 'builtin' ? (
          <Badge variant="outline" className="shrink-0">
            {translate('auto.components.settings.AgentSessionRuleRow.builtinBadge', 'Built-in')}
          </Badge>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={translate(
              'auto.components.settings.AgentSessionRuleRow.deleteRule',
              'Delete rule'
            )}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
        <ToggleSwitch
          checked={rule.enabled}
          onChange={onToggleEnabled}
          label={translate(
            'auto.components.settings.AgentSessionRuleRow.toggleRuleEnabled',
            'Enable {{value0}}',
            { value0: rule.label }
          )}
        />
      </div>
      <textarea
        value={rule.content}
        disabled={!editable}
        rows={4}
        spellCheck={false}
        onChange={(event) => onContentChange(event.target.value)}
        placeholder={translate(
          'auto.components.settings.AgentSessionRuleRow.ruleContentPlaceholder',
          'Rule text applied to supported agent launches.'
        )}
        className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
      />
      {editable && dirty ? (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="xs" onClick={onDiscard}>
            {translate('auto.components.settings.AgentSessionRuleRow.discard', 'Discard')}
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={onSave}>
            {translate('auto.components.settings.AgentSessionRuleRow.save', 'Save')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
