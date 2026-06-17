import { useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { DevRule, GlobalSettings } from '../../../../shared/types'
import { getDevRuleScope } from '../../../../shared/dev-rules'
import { createDevRuleDraft, DevRuleDialog } from '@/components/dev-rules/DevRuleDialog'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { translate } from '@/i18n/i18n'
import { DevRulesList } from './DevRulesList'

type DevRulesPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

type EditorState = { mode: 'add' | 'edit'; rule: DevRule } | null

// Why: settings can change between the user opening the editor and saving (e.g.
// another window edits the list), so always re-read the latest list from the
// store before writing rather than closing over a stale snapshot.
function getLatestDevRules(): DevRule[] {
  return useAppStore.getState().settings?.devRules ?? []
}

export function DevRulesPane({ settings, updateSettings }: DevRulesPaneProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const rules = settings.devRules ?? []
  const confirm = useConfirmationDialog()
  const [editor, setEditor] = useState<EditorState>(null)
  const [applying, setApplying] = useState(false)

  const repoById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])

  // Global rules first, then repo-scoped — mirrors how they render into the
  // worktree files, so the list order matches the injected output.
  const orderedRules = [
    ...rules.filter((rule) => getDevRuleScope(rule).type === 'global'),
    ...rules.filter((rule) => getDevRuleScope(rule).type === 'repo')
  ]

  const createDraftForContext = (): DevRule =>
    activeRepoId && repoById.has(activeRepoId)
      ? createDevRuleDraft({ type: 'repo', repoId: activeRepoId })
      : createDevRuleDraft({ type: 'global' })

  const saveRule = (next: DevRule): void => {
    const latest = getLatestDevRules()
    const isEdit = latest.some((rule) => rule.id === next.id)
    const nextList = isEdit
      ? latest.map((rule) => (rule.id === next.id ? next : rule))
      : [...latest, next]
    updateSettings({ devRules: nextList })
  }

  const toggleRule = (rule: DevRule): void => {
    const latest = getLatestDevRules()
    updateSettings({
      devRules: latest.map((current) =>
        current.id === rule.id ? { ...current, enabled: !current.enabled } : current
      )
    })
  }

  const removeRule = async (rule: DevRule): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'auto.components.settings.DevRulesPane.deleteTitle',
        'Delete “{{value0}}”?',
        {
          value0: rule.name || 'Untitled rule'
        }
      ),
      description: translate(
        'auto.components.settings.DevRulesPane.deleteDescription',
        'This dev rule will be removed from your saved list. Existing worktrees update when you create a new one or re-apply rules.'
      ),
      confirmLabel: translate('auto.components.settings.DevRulesPane.deleteConfirm', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    const latest = getLatestDevRules()
    updateSettings({ devRules: latest.filter((current) => current.id !== rule.id) })
  }

  const applyToExistingWorktrees = async (): Promise<void> => {
    setApplying(true)
    try {
      const { applied } = await window.api.settings.applyDevRulesToExistingWorktrees()
      toast(
        translate(
          'auto.components.settings.DevRulesPane.applied',
          'Dev rules applied to {{value0}} worktree(s).',
          { value0: applied }
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.settings.DevRulesPane.applyFailed',
          'Could not apply dev rules to existing worktrees.'
        )
      )
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="space-y-1">
          <Label>{translate('auto.components.settings.DevRulesPane.title', 'Dev Rules')}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.DevRulesPane.description',
              'Coding principles and additive system messages written into each worktree’s AGENTS.md and CLAUDE.md. Enabled rules apply to new worktrees.'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={applying || rules.length === 0}
            onClick={() => void applyToExistingWorktrees()}
            title={translate(
              'auto.components.settings.DevRulesPane.applyTooltip',
              'Re-write enabled rules into every existing worktree’s AGENTS.md and CLAUDE.md.'
            )}
          >
            <RefreshCw className={applying ? 'animate-spin' : undefined} />
            {translate('auto.components.settings.DevRulesPane.applyExisting', 'Apply to worktrees')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditor({ mode: 'add', rule: createDraftForContext() })}
          >
            <Plus />
            {translate('auto.components.settings.DevRulesPane.addRule', 'Add Rule')}
          </Button>
        </div>
      </div>

      <DevRulesList
        rules={orderedRules}
        repoById={repoById}
        onToggle={toggleRule}
        onEdit={(rule) => setEditor({ mode: 'edit', rule })}
        onRemove={(rule) => void removeRule(rule)}
      />

      {editor !== null ? (
        <DevRuleDialog
          open
          mode={editor.mode}
          rule={editor.rule}
          repos={repos}
          onOpenChange={(open) => !open && setEditor(null)}
          onSave={saveRule}
        />
      ) : null}
    </div>
  )
}
