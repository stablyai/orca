import { useState } from 'react'
import type React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import {
  MAX_SOURCE_CONTROL_CUSTOM_ACTIONS,
  type SourceControlCustomAction
} from '../../../../shared/source-control-custom-actions'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { SourceControlCustomActionDialog } from './SourceControlCustomActionDialog'
import {
  getSourceControlCustomActionsSearchEntries,
  SOURCE_CONTROL_CUSTOM_ACTIONS_SECTION_ID
} from './source-control-custom-actions-section'

// Why: the session outlives close so the exit animation keeps its title and fields.
type EditorSession = {
  key: number
  open: boolean
  mode: 'add' | 'edit'
  action: SourceControlCustomAction | null
}

export function upsertSourceControlCustomAction(
  actions: readonly SourceControlCustomAction[] | undefined,
  action: SourceControlCustomAction
): SourceControlCustomAction[] {
  const current = actions ?? []
  return current.some((candidate) => candidate.id === action.id)
    ? current.map((candidate) => (candidate.id === action.id ? action : candidate))
    : [...current, action]
}

function CustomActionRow({
  action,
  onEdit,
  onRemove
}: {
  action: SourceControlCustomAction
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="group/ca flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/60 focus-within:bg-accent/60">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{action.label}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {action.agentId ? (
            <span className="shrink-0">
              <AgentIcon agent={action.agentId} size={12} />
            </span>
          ) : null}
          <span className="truncate font-mono">{action.commandInputTemplate}</span>
        </div>
      </div>
      {/* Why can-hover: touch devices never hover, so the actions must stay visible there. */}
      <div className="flex shrink-0 items-center gap-0.5 transition-opacity can-hover:opacity-0 group-hover/ca:opacity-100 group-focus-within/ca:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={translate('pullRequestCustomActions.settings.edit', 'Edit {{value0}}', {
            value0: action.label
          })}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={translate('pullRequestCustomActions.settings.remove', 'Remove {{value0}}', {
            value0: action.label
          })}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  )
}

export function SourceControlCustomActionsPane({
  settings,
  searchQuery,
  writeSourceControlAiSettings
}: {
  settings: GlobalSettings
  searchQuery: string
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
}): React.JSX.Element | null {
  const [editor, setEditor] = useState<EditorSession | null>(null)
  const openEditor = (
    mode: EditorSession['mode'],
    action: SourceControlCustomAction | null
  ): void => setEditor((current) => ({ key: (current?.key ?? 0) + 1, open: true, mode, action }))
  const confirm = useConfirmationDialog()
  const actions = settings.sourceControlAi?.customActions ?? []
  const [searchEntry] = getSourceControlCustomActionsSearchEntries()

  if (!matchesSettingsSearch(searchQuery, searchEntry)) {
    return null
  }

  const saveAction = async (action: SourceControlCustomAction): Promise<boolean> => {
    try {
      await writeSourceControlAiSettings((current) => ({
        customActions: upsertSourceControlCustomAction(current.customActions, action)
      }))
      return true
    } catch (error) {
      toast.error(
        translate(
          'pullRequestCustomActions.settings.saveFailed',
          'Failed to save custom action: {{value0}}',
          { value0: error instanceof Error ? error.message : String(error) }
        )
      )
      return false
    }
  }

  const removeAction = async (action: SourceControlCustomAction): Promise<void> => {
    const confirmed = await confirm({
      title: translate('pullRequestCustomActions.settings.removeTitle', 'Delete "{{value0}}"?', {
        value0: action.label
      }),
      description: translate(
        'pullRequestCustomActions.settings.removeDescription',
        'This custom action will be removed from the pull request menu.'
      ),
      confirmLabel: translate('pullRequestCustomActions.settings.removeConfirm', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    try {
      await writeSourceControlAiSettings((current) => ({
        customActions: (current.customActions ?? []).filter(
          (candidate) => candidate.id !== action.id
        )
      }))
    } catch (error) {
      toast.error(
        translate(
          'pullRequestCustomActions.settings.removeFailed',
          'Failed to delete custom action: {{value0}}',
          { value0: error instanceof Error ? error.message : String(error) }
        )
      )
    }
  }

  const atLimit = actions.length >= MAX_SOURCE_CONTROL_CUSTOM_ACTIONS

  return (
    <SearchableSetting
      id={SOURCE_CONTROL_CUSTOM_ACTIONS_SECTION_ID}
      title={searchEntry.title}
      description={searchEntry.description}
      keywords={searchEntry.keywords}
      className="space-y-3 border-t border-border/40 pt-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label>{searchEntry.title}</Label>
          <p className="text-xs text-muted-foreground">{searchEntry.description}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atLimit}
          onClick={() => openEditor('add', null)}
        >
          <Plus />
          {translate('pullRequestCustomActions.settings.add', 'Add action')}
        </Button>
      </div>
      {actions.length > 0 ? (
        <div className="space-y-0.5">
          {actions.map((action) => (
            <CustomActionRow
              key={action.id}
              action={action}
              onEdit={() => openEditor('edit', action)}
              onRemove={() => void removeAction(action)}
            />
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'pullRequestCustomActions.settings.empty',
            'No custom actions yet. Add one, such as a review command that takes {prUrl}.'
          )}
        </p>
      )}
      {atLimit ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'pullRequestCustomActions.settings.limit',
            'You can save up to {{value0}} custom actions.',
            { value0: MAX_SOURCE_CONTROL_CUSTOM_ACTIONS }
          )}
        </p>
      ) : null}
      {editor ? (
        <SourceControlCustomActionDialog
          key={editor.key}
          open={editor.open}
          mode={editor.mode}
          action={editor.action}
          defaultTuiAgent={settings.defaultTuiAgent}
          onOpenChange={(open) => {
            if (!open) {
              setEditor((current) => (current ? { ...current, open: false } : current))
            }
          }}
          onSave={saveAction}
        />
      ) : null}
    </SearchableSetting>
  )
}
