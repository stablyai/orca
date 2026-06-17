import { useRef, useState } from 'react'
import type { DevRule, DevRuleScope, Repo } from '../../../../shared/types'
import { getDevRuleScope } from '../../../../shared/dev-rules'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'

type DevRuleDialogMode = 'add' | 'edit'

type DevRuleRepo = Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>

type DevRuleDialogProps = {
  open: boolean
  mode: DevRuleDialogMode
  rule: DevRule
  repos?: DevRuleRepo[]
  onOpenChange: (open: boolean) => void
  onSave: (rule: DevRule) => void
}

const EMPTY_REPOS: DevRuleRepo[] = []

export function createDevRuleDraft(scope: DevRuleScope = { type: 'global' }): DevRule {
  return {
    id: `dev-rule-${createBrowserUuid()}`,
    name: '',
    content: '',
    enabled: true,
    scope
  }
}

function getRepoLabel(repo: Pick<Repo, 'displayName' | 'path'>): string {
  return repo.displayName || repo.path
}

export function DevRuleDialog({
  open,
  mode,
  rule,
  repos = EMPTY_REPOS,
  onOpenChange,
  onSave
}: DevRuleDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<DevRule>(rule)
  const wasOpenRef = useRef(open)
  const syncedRuleRef = useRef(rule)
  const initialScope = getDevRuleScope(rule)
  // Why: remember the last repo a rule was scoped to, so toggling Global→Project
  // restores that choice rather than silently snapping to the first repo.
  const lastRepoScopeIdRef = useRef<string | null>(
    initialScope.type === 'repo' ? initialScope.repoId : null
  )

  if (!open) {
    wasOpenRef.current = false
  } else if (!wasOpenRef.current || syncedRuleRef.current !== rule) {
    wasOpenRef.current = true
    syncedRuleRef.current = rule
    const scope = getDevRuleScope(rule)
    lastRepoScopeIdRef.current = scope.type === 'repo' ? scope.repoId : null
    setDraft({ ...rule })
  }

  const selectedScope = getDevRuleScope(draft)
  const selectedRepo =
    selectedScope.type === 'repo'
      ? (repos.find((repo) => repo.id === selectedScope.repoId) ?? null)
      : null
  const selectedRepoId = selectedRepo?.id ?? ''
  const selectedRepoMissing = selectedScope.type === 'repo' && selectedRepo === null

  const canSave = draft.content.trim().length > 0

  const saveDraft = (): void => {
    const next: DevRule = {
      id: draft.id,
      name: draft.name.trim(),
      content: draft.content.trim(),
      enabled: draft.enabled,
      scope: selectedScope
    }
    if (!next.content) {
      return
    }
    onSave(next)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {mode === 'edit'
              ? translate('auto.components.dev.rules.DevRuleDialog.edit', 'Edit Dev Rule')
              : translate('auto.components.dev.rules.DevRuleDialog.add', 'Add Dev Rule')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.dev.rules.DevRuleDialog.description',
              'Dev rules are added to each worktree’s AGENTS.md and CLAUDE.md so every agent reads them.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div
          className="space-y-4"
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event) && canSave) {
              event.preventDefault()
              saveDraft()
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="dev-rule-name">
              {translate('auto.components.dev.rules.DevRuleDialog.nameLabel', 'Name')}
            </Label>
            <Input
              id="dev-rule-name"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
              placeholder={translate(
                'auto.components.dev.rules.DevRuleDialog.namePlaceholder',
                'e.g. Immutability, Testing standards'
              )}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="dev-rule-content">
              {translate('auto.components.dev.rules.DevRuleDialog.contentLabel', 'Rule')}
            </Label>
            <textarea
              id="dev-rule-content"
              rows={10}
              value={draft.content}
              onChange={(event) =>
                setDraft((current) => ({ ...current, content: event.target.value }))
              }
              placeholder={translate(
                'auto.components.dev.rules.DevRuleDialog.contentPlaceholder',
                'Paste your coding principles, conventions, or additive system message…'
              )}
              className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <Label>
              {translate('auto.components.dev.rules.DevRuleDialog.scopeLabel', 'Scope')}
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                value={selectedScope.type}
                onValueChange={(value) => {
                  if (value === 'global') {
                    setDraft((current) => ({ ...current, scope: { type: 'global' } }))
                  }
                  if (value === 'repo' && selectedScope.type !== 'repo') {
                    const repoId = lastRepoScopeIdRef.current ?? repos[0]?.id ?? null
                    if (!repoId) {
                      return
                    }
                    lastRepoScopeIdRef.current = repoId
                    setDraft((current) => ({ ...current, scope: { type: 'repo', repoId } }))
                  }
                }}
                className="justify-start"
                variant="outline"
              >
                <ToggleGroupItem value="global">
                  {translate('auto.components.dev.rules.DevRuleDialog.scopeGlobal', 'Global')}
                </ToggleGroupItem>
                <ToggleGroupItem value="repo" disabled={repos.length === 0}>
                  {translate('auto.components.dev.rules.DevRuleDialog.scopeProject', 'Project')}
                </ToggleGroupItem>
              </ToggleGroup>
              {selectedScope.type === 'repo' && repos.length > 0 ? (
                <Select
                  value={selectedRepoId}
                  onValueChange={(repoId) => {
                    lastRepoScopeIdRef.current = repoId
                    setDraft((current) => ({ ...current, scope: { type: 'repo', repoId } }))
                  }}
                >
                  <SelectTrigger size="sm" className="min-w-48">
                    <SelectValue
                      placeholder={
                        selectedRepoMissing
                          ? translate(
                              'auto.components.dev.rules.DevRuleDialog.projectMissing',
                              'Project not in list'
                            )
                          : translate(
                              'auto.components.dev.rules.DevRuleDialog.projectChoose',
                              'Choose project'
                            )
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {repos.map((repo) => (
                      <SelectItem key={repo.id} value={repo.id}>
                        <RepoBadgeLabel
                          name={getRepoLabel(repo)}
                          color={repo.badgeColor}
                          className="max-w-full"
                        />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {translate('auto.components.dev.rules.DevRuleDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" size="sm" disabled={!canSave} onClick={saveDraft}>
            {translate('auto.components.dev.rules.DevRuleDialog.save', 'Save')}
            <span className="ml-1.5 text-[10px] opacity-70">{getScreenSubmitShortcutLabel()}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
