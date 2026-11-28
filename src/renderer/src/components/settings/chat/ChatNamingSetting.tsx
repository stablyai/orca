import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { resolveSourceControlAiForOperation } from '../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { CUSTOM_AGENT_ID } from '../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { Switch } from '../../ui/switch'
import { SourceControlActionRecipeRow } from '../source-control/SourceControlActionRecipeRow'
import { useGlobalTextActionRecipeDraft } from '../source-control/use-global-text-action-recipe-draft'
import { CustomAgentCommandField } from '../source-control/CustomAgentCommandField'
import { useAppStore } from '../../../store/index'
import { matchesSettingsSearch } from '../search/settings-search'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsGroupDisclosure } from '../section-layout/SettingsGroupDisclosure'
import { CHAT_NAME_AGENT_SECTION_ID, getChatNamingSearchEntry } from './chat-naming-search'

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
}: ChatNamingSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const query = useAppStore((state) => state.settingsSearchQuery)
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
    actionId: 'conversationName',
    settings,
    writeSourceControlAiSettings,
    onDirtyChange,
    onSaveError: (error) => {
      console.error('Failed to save chat name recipe', error)
      toast.error(t('settings.chat.names.saveFailed', 'Could not save chat name settings.'))
    }
  })

  const cliRecipe = value.agentArgs?.trim()
    ? resolveSourceControlAiForOperation({
        settings: {
          ...settings,
          sourceControlAi: {
            ...config,
            actions: {
              ...config.actions,
              conversationName: {
                ...recipe,
                ...value,
                ...(recipe?.agentId ? { agentId: null } : {})
              }
            }
          }
        },
        operation: 'conversationName'
      })
    : null
  const cliAgent = cliRecipe?.ok ? cliRecipe.value.params.agentId : null
  const defaultAgentLabel = cliAgent
    ? t('settings.chat.names.configuredCliAgent', 'Use configured CLI agent ({{agent}})', {
        agent:
          cliAgent === 'custom'
            ? t(
                'auto.components.settings.SourceControlAiActionRecipeDefaults.0740d30915',
                'Custom command'
              )
            : getAgentLabel(cliAgent)
      })
    : cliRecipe
      ? t('settings.chat.names.configuredCliAgentUnknown', 'Use configured CLI agent')
      : t('settings.chat.names.useChatAgent', 'Use chat agent')
  const searchEntry = getChatNamingSearchEntry()
  // Skip the whole group, not just its row, so a filtered-out row leaves no titled empty card.
  if (!forceVisible && !dirty && !matchesSettingsSearch(query, [searchEntry])) {
    return null
  }
  return (
    // The anchor wraps the group so navigation lands on the Chat names heading.
    <SettingsGroup id="chat-names" title={searchEntry.title}>
      <SearchableSetting
        {...searchEntry}
        forceVisible={forceVisible || dirty}
        className="max-w-none"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{searchEntry.description}</p>
          </div>
          <Switch
            aria-label={t('settings.chat.names.enable', 'Name chats automatically')}
            checked={settings.nativeChatAutoName !== false}
            onCheckedChange={(checked) => updateSettings({ nativeChatAutoName: checked })}
          />
        </div>
        {/* Manual names need it too; a chosen naming agent names Antigravity chats instead. */}
        {!recipe?.agentId && !recipe?.agentArgs?.trim() ? (
          <SettingsSwitchRow
            className="mt-3"
            label={t('settings.chat.names.antigravity', 'Generate chat titles with Antigravity')}
            description={antigravityNamingCopy(t, settings.antigravityChatAuth?.method)}
            checked={settings.antigravityChatNaming === true}
            onChange={() =>
              updateSettings({ antigravityChatNaming: settings.antigravityChatNaming !== true })
            }
          />
        ) : null}
        {/* Inside the row so the naming anchor and highlight cover its Advanced recipe too. */}
        {settings.nativeChatAutoName !== false || dirty ? (
          <div className="mt-3">
            <SettingsGroupDisclosure forceOpen={dirty || isSaving}>
              <div className="space-y-3 pt-1 pb-2">
                {recipe?.agentId === CUSTOM_AGENT_ID ||
                cliAgent === CUSTOM_AGENT_ID ||
                customCommandDirty ? (
                  <CustomAgentCommandField
                    id="chat-name-custom-command"
                    value={customCommand}
                    onChange={updateCustomCommandDraft}
                    description={t(
                      'settings.chat.names.customCommandDescription',
                      'Command line shared by recipes that select Custom command. Use {prompt} to pass the input as an argument; otherwise it is piped to stdin.'
                    )}
                  />
                ) : null}
                <SourceControlActionRecipeRow
                  actionId="conversationName"
                  sectionId={CHAT_NAME_AGENT_SECTION_ID}
                  source={config}
                  onTextModelChoiceChange={(_id, modelChoice, agentArgs, modelEdits) =>
                    updateDraft({ ...value, modelChoice, agentArgs, modelEdits })
                  }
                  writeSourceControlAiSettings={writeSourceControlAiSettings}
                  selectedAgent={recipe?.agentId ?? null}
                  defaultAgentLabel={defaultAgentLabel}
                  defaultAgentSupportText={
                    cliRecipe && !cliRecipe.ok
                      ? cliRecipe.error
                      : cliRecipe
                        ? t(
                            'settings.chat.names.clearCliArguments',
                            'Clear CLI arguments to use each chat’s agent.'
                          )
                        : undefined
                  }
                  defaultAgentArgsPlaceholder={
                    cliAgent
                      ? undefined
                      : t(
                          'settings.chat.names.cliArgumentsPlaceholder',
                          'Optional arguments for a configured CLI naming agent'
                        )
                  }

                  draftValue={value}
                  baseValue={persisted}
                  hasUnsavedChanges={dirty}
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
              </div>
            </SettingsGroupDisclosure>
          </div>
        ) : null}
        <span ref={clearDirtyOnUnmount} />
      </SearchableSetting>
    </SettingsGroup>
  )
}

/** Where a naming run's usage lands depends on the saved Antigravity sign-in method. */
function antigravityNamingCopy(
  t: Translate,
  method: AntigravityChatAuthConfig['method'] | undefined
): string {
  switch (method) {
    case 'oauth-business':
      return t(
        'settings.chat.names.antigravityEnterprise',
        'Sends each chat’s first message to Antigravity to name it, which uses your Gemini Enterprise quota.'
      )
    case 'gemini-api-key':
      return t(
        'settings.chat.names.antigravityApiKey',
        'Sends each chat’s first message to Antigravity to name it, billed to your Gemini API key.'
      )
    case 'agent-platform':
      return t(
        'settings.chat.names.antigravityAgentPlatform',
        'Sends each chat’s first message to Antigravity to name it, billed to your Google Cloud project.'
      )
    case 'oauth-personal':
    case undefined:
      return t(
        'settings.chat.names.antigravityGoogle',
        'Sends each chat’s first message to Antigravity to name it, which uses your Antigravity quota on your Google account.'
      )
  }
}
