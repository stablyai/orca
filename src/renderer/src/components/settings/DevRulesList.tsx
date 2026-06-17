import { Pencil, Trash2 } from 'lucide-react'
import type { DevRule, DevRuleScope, Repo } from '../../../../shared/types'
import { getDevRuleScope } from '../../../../shared/dev-rules'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { RepoBadgeMark } from '../repo/RepoBadgeLabel'

type DevRuleRepo = Pick<Repo, 'displayName' | 'path' | 'badgeColor'>

function getScopeLabel(scope: DevRuleScope, repoById: Map<string, DevRuleRepo>): string {
  if (scope.type === 'global') {
    return translate('auto.components.settings.DevRulesList.scopeGlobal', 'Global')
  }
  const repo = repoById.get(scope.repoId)
  if (!repo) {
    return translate('auto.components.settings.DevRulesList.scopeMissing', 'Missing project')
  }
  return repo.displayName || repo.path
}

function DevRuleToggle({
  enabled,
  label,
  onToggle
}: {
  enabled: boolean
  label: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
        enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-background shadow-sm transition-transform',
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

function DevRuleRow({
  rule,
  repoById,
  onToggle,
  onEdit,
  onRemove
}: {
  rule: DevRule
  repoById: Map<string, DevRuleRepo>
  onToggle: (rule: DevRule) => void
  onEdit: (rule: DevRule) => void
  onRemove: (rule: DevRule) => void
}): React.JSX.Element {
  const scope = getDevRuleScope(rule)
  const untitled = translate('auto.components.settings.DevRulesList.untitled', 'Untitled rule')
  const displayName = rule.name || untitled
  // Collapse the multi-line body into a single-line preview.
  const preview = rule.content.replace(/\s+/g, ' ').trim()
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2 shadow-xs',
        !rule.enabled && 'opacity-60'
      )}
    >
      <DevRuleToggle
        enabled={rule.enabled}
        label={translate('auto.components.settings.DevRulesList.toggleAria', 'Enable {{value0}}', {
          value0: displayName
        })}
        onToggle={() => onToggle(rule)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">{displayName}</div>
          <Badge variant="outline" className="max-w-44 gap-1.5">
            {scope.type === 'repo' ? (
              <>
                <RepoBadgeMark color={repoById.get(scope.repoId)?.badgeColor} />
                <span className="truncate">{getScopeLabel(scope, repoById)}</span>
              </>
            ) : (
              <span className="truncate">{getScopeLabel(scope, repoById)}</span>
            )}
          </Badge>
        </div>
        <div className="truncate text-xs text-foreground/70">
          {preview ||
            translate('auto.components.settings.DevRulesList.noContent', 'No rule text yet')}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={translate('auto.components.settings.DevRulesList.editAria', 'Edit {{value0}}', {
          value0: displayName
        })}
        onClick={() => onEdit(rule)}
      >
        <Pencil />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={translate(
          'auto.components.settings.DevRulesList.removeAria',
          'Remove {{value0}}',
          { value0: displayName }
        )}
        onClick={() => onRemove(rule)}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 />
      </Button>
    </div>
  )
}

export function DevRulesList({
  rules,
  repoById,
  onToggle,
  onEdit,
  onRemove
}: {
  rules: DevRule[]
  repoById: Map<string, DevRuleRepo>
  onToggle: (rule: DevRule) => void
  onEdit: (rule: DevRule) => void
  onRemove: (rule: DevRule) => void
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
      {rules.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          {translate('auto.components.settings.DevRulesList.empty', 'No dev rules yet.')}
        </div>
      ) : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2 scrollbar-sleek">
          {rules.map((rule) => (
            <DevRuleRow
              key={rule.id}
              rule={rule}
              repoById={repoById}
              onToggle={onToggle}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  )
}
