import { useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { CUSTOM_AGENT_ID } from '../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import {
  WORKSPACE_ICON_DEFAULT_AGENT,
  WORKSPACE_ICON_DEFAULT_MODEL
} from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { useTranslate } from '@/i18n/use-translate'
import { regenerateWorktreeAiIcons } from '../../sidebar/use-worktree-ai-icon'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { CustomAgentCommandField } from './CustomAgentCommandField'
import { SourceControlActionRecipeRow } from './SourceControlActionRecipeRow'
import { useGlobalTextActionRecipeDraft } from './use-global-text-action-recipe-draft'
import { getWorkspaceIconSearchEntry } from './workspace-icon-search'

type WorkspaceIconSettingProps = {
  settings: GlobalSettings
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  forceVisible?: boolean
}

export function WorkspaceIconSetting({
  settings,
  writeSourceControlAiSettings,
  onDirtyChange,
  forceVisible = false
}: WorkspaceIconSettingProps): React.JSX.Element {
  const t = useTranslate()
  const [regenerating, setRegenerating] = useState(false)
  const {
    config,
    recipe,
    persisted,
    value,
    dirty,
    customCommand,
    customCommandDirty,
    isSaving,
    clearDirtyOnUnmount,
    updateDraft,
    updateCustomCommandDraft,
    discard,
    save,
    saveAgent,
    appendVariable
  } = useGlobalTextActionRecipeDraft({
    actionId: 'workspaceIcon',
    settings,
    writeSourceControlAiSettings,
    onDirtyChange,
    onSaveError: (error) => {
      console.error('Failed to save workspace icon recipe', error)
      toast.error(
        t('settings.git.workspaceIcons.saveFailed', 'Could not save workspace icon settings.')
      )
    }
  })
  const searchEntry = getWorkspaceIconSearchEntry()

  const regenerate = async (): Promise<void> => {
    setRegenerating(true)
    try {
      await regenerateWorktreeAiIcons()
    } catch (error) {
      console.error('Failed to clear workspace icons', error)
      toast.error(
        t('settings.git.workspaceIcons.regenerateFailed', 'Could not clear the saved icons.')
      )
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <SearchableSetting
      {...searchEntry}
      forceVisible={forceVisible || dirty}
      className="space-y-3 py-3"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <Label>{searchEntry.title}</Label>
          <p className="text-xs text-muted-foreground">{searchEntry.description}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={regenerating}
          onClick={() => void regenerate()}
        >
          {t('settings.git.workspaceIcons.regenerate', 'Regenerate icons')}
        </Button>
      </div>
      {recipe?.agentId === CUSTOM_AGENT_ID || customCommandDirty ? (
        <CustomAgentCommandField
          id="workspace-icon-custom-command"
          value={customCommand}
          onChange={updateCustomCommandDraft}
        />
      ) : null}
      <SourceControlActionRecipeRow
        actionId="workspaceIcon"
        source={config}
        onTextModelChoiceChange={(_id, modelChoice, agentArgs, modelEdits) =>
          updateDraft({ ...value, modelChoice, agentArgs, modelEdits })
        }
        writeSourceControlAiSettings={writeSourceControlAiSettings}
        selectedAgent={recipe?.agentId ?? null}
        defaultAgentLabel={t('settings.git.workspaceIcons.defaultAgent', 'Default (Claude Haiku)')}
        defaultAgentArgsPlaceholder={`--model ${WORKSPACE_ICON_DEFAULT_MODEL}`}
        draftValue={value}
        baseValue={persisted}
        hasUnsavedChanges={dirty}
        defaultTuiAgent={WORKSPACE_ICON_DEFAULT_AGENT}
        isSavingTemplate={isSaving}
        onAgentChange={(_id, selected) => void saveAgent(selected)}
        onTemplateChange={(_id, template) =>
          updateDraft({ ...value, commandInputTemplate: template })
        }
        onAgentArgsChange={(_id, agentArgs) => updateDraft({ ...value, agentArgs })}
        onAppendVariable={(_id, variable) => appendVariable(variable)}
        onDiscard={discard}
        onSave={() => void save()}
      />
      <span ref={clearDirtyOnUnmount} />
    </SearchableSetting>
  )
}
