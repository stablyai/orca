import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  setSourceControlActionDefault
} from '../../../../shared/source-control-ai-actions'
import { CUSTOM_AGENT_ID } from '../../../../shared/commit-message-agent-spec'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { translate } from '@/i18n/i18n'
import { Switch } from '../ui/switch'
import { Card, CardContent } from '../ui/card'
import { SourceControlActionRecipeRow } from './SourceControlActionRecipeRow'
import { CustomAgentCommandField } from './CustomAgentCommandField'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getChatNamingSearchEntry } from './chat-naming-search'
import type { ActionRecipeDraftValue } from './source-control-ai-action-recipe-draft'

type ChatNamingSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  forceVisible?: boolean
}

export function ChatNamingSetting({
  settings,
  updateSettings,
  writeSourceControlAiSettings,
  onDirtyChange,
  forceVisible = false
}: ChatNamingSettingProps): React.JSX.Element {
  const config = normalizeSourceControlAiSettings(
    settings.sourceControlAi,
    settings.commitMessageAi
  )
  const recipe = config.actions?.conversationName
  const persisted: ActionRecipeDraftValue = {
    commandInputTemplate:
      recipe?.commandInputTemplate ??
      DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.conversationName,
    agentArgs: recipe?.agentArgs ?? ''
  }
  const [draft, setDraft] = useState<ActionRecipeDraftValue | null>(null)
  const [customCommandDraft, setCustomCommandDraft] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const value = draft ?? persisted
  const customCommand = customCommandDraft ?? config.customAgentCommand
  const customCommandDirty = customCommand !== config.customAgentCommand
  const recipeDirty = JSON.stringify(value) !== JSON.stringify(persisted)
  const latestValueRef = useRef({ value, customCommand, customCommandDraft })
  const dirty = recipeDirty || customCommandDirty
  const onDirtyChangeRef = useRef(onDirtyChange)
  useLayoutEffect(() => {
    latestValueRef.current = { value, customCommand, customCommandDraft }
    onDirtyChangeRef.current = onDirtyChange
  }, [value, customCommand, customCommandDraft, onDirtyChange])
  const isMountedRef = useRef(false)
  const clearDirtyOnUnmount = useCallback((node: HTMLSpanElement | null): void => {
    isMountedRef.current = node !== null
    if (node === null) {
      onDirtyChangeRef.current?.(false)
    }
  }, [])

  const updateDraft = (next: ActionRecipeDraftValue): void => {
    latestValueRef.current = { value: next, customCommand, customCommandDraft }
    setDraft(next)
    onDirtyChange?.(JSON.stringify(next) !== JSON.stringify(persisted) || customCommandDirty)
  }

  const updateCustomCommandDraft = (next: string): void => {
    const changed = next !== config.customAgentCommand
    latestValueRef.current = { value, customCommand: next, customCommandDraft: next }
    setCustomCommandDraft(next)
    onDirtyChange?.(recipeDirty || changed)
  }

  const save = async (): Promise<void> => {
    if (!dirty || isSaving) {
      return
    }
    setIsSaving(true)
    try {
      await writeSourceControlAiSettings((current) => ({
        actions: setSourceControlActionDefault(current.actions, 'conversationName', value),
        ...(customCommandDirty ? { customAgentCommand: customCommand } : {})
      }))
      if (!isMountedRef.current) {
        return
      }
      const latestValue = latestValueRef.current
      const hasNewEdits = JSON.stringify(latestValue.value) !== JSON.stringify(value)
      const hasNewCommandEdits =
        latestValue.customCommandDraft !== null && latestValue.customCommand !== customCommand
      setDraft(hasNewEdits ? latestValue.value : null)
      setCustomCommandDraft(hasNewCommandEdits ? latestValue.customCommand : null)
      onDirtyChangeRef.current?.(hasNewEdits || hasNewCommandEdits)
    } catch (error) {
      console.error('Failed to save chat name recipe', error)
      toast.error(translate('settings.chat.names.saveFailed', 'Could not save chat name settings.'))
    } finally {
      setIsSaving(false)
    }
  }

  const saveAgent = async (selected: string): Promise<void> => {
    const agentId =
      selected === '__default_agent__'
        ? null
        : selected === CUSTOM_AGENT_ID
          ? CUSTOM_AGENT_ID
          : isTuiAgent(selected)
            ? selected
            : null
    try {
      await writeSourceControlAiSettings((current) => ({
        actions: setSourceControlActionDefault(current.actions, 'conversationName', { agentId })
      }))
    } catch (error) {
      console.error('Failed to save chat name agent', error)
      toast.error(translate('settings.chat.names.saveFailed', 'Could not save chat name settings.'))
    }
  }

  const searchEntry = getChatNamingSearchEntry()
  return (
    <SearchableSetting
      {...searchEntry}
      id="chat-names"
      forceVisible={forceVisible || dirty}
      className="max-w-none space-y-3"
    >
      <SettingsSubsectionHeader title={searchEntry.title} />
      <Card>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{searchEntry.description}</p>
              </div>
              <Switch
                aria-label={translate('settings.chat.names.enable', 'Name chats automatically')}
                checked={settings.nativeChatAutoName !== false}
                onCheckedChange={(checked) => updateSettings({ nativeChatAutoName: checked })}
              />
            </div>
            {settings.nativeChatAutoName !== false || dirty ? (
              <>
                {recipe?.agentId === CUSTOM_AGENT_ID || customCommandDirty ? (
                  <CustomAgentCommandField
                    id="chat-name-custom-command"
                    value={customCommand}
                    onChange={updateCustomCommandDraft}
                    description={translate(
                      'settings.chat.names.customCommandDescription',
                      'Command line shared by recipes that select Custom command. Use {prompt} to pass the input as an argument; otherwise it is piped to stdin.'
                    )}
                  />
                ) : null}
                <SourceControlActionRecipeRow
                  actionId="conversationName"
                  selectedAgent={recipe?.agentId ?? null}
                  draftValue={value}
                  baseValue={persisted}
                  hasUnsavedChanges={dirty}
                  defaultTuiAgent={settings.defaultTuiAgent}
                  isSavingTemplate={isSaving}
                  onAgentChange={(_id, selected) => void saveAgent(selected)}
                  onTemplateChange={(_id, template) =>
                    updateDraft({ ...value, commandInputTemplate: template })
                  }
                  onAgentArgsChange={(_id, agentArgs) => updateDraft({ ...value, agentArgs })}
                  onAppendVariable={(_id, variable) => {
                    const template = value.commandInputTemplate
                    const separator = template.endsWith('\n') || template.length === 0 ? '' : ' '
                    updateDraft({
                      ...value,
                      commandInputTemplate: `${template}${separator}{${variable}}`
                    })
                  }}
                  onDiscard={() => {
                    setDraft(null)
                    setCustomCommandDraft(null)
                    onDirtyChange?.(false)
                  }}
                  onSave={() => void save()}
                />
              </>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <span ref={clearDirtyOnUnmount} />
    </SearchableSetting>
  )
}
