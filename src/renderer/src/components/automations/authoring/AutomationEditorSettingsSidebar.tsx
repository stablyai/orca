import { useId } from 'react'
import { Switch } from '@/components/ui/switch'
import type { AutomationAuthorityRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { AutomationAgentLaunchPicker } from './AutomationAgentLaunchPicker'
import type { ProspectiveWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { useTranslate } from '@/i18n/use-translate'
import { isValidAutomationSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-parsing'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { OrcaHooks } from '../../../../../shared/workspace-setup/orca-yaml-hook-types'
import type { ProjectHostSetup } from '../../../../../shared/project/project-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from '../automation-page-parts'
import { AutomationMissedRunGraceField } from './AutomationMissedRunGraceField'
import { AutomationPrecheckFields } from './AutomationPrecheckFields'
import AutomationProjectCombobox from './AutomationProjectCombobox'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'
import { AutomationSessionField } from './AutomationSessionField'
import { AutomationSetupDecisionField } from './AutomationSetupDecisionField'
import { AutomationWorkspaceField } from './AutomationWorkspaceField'
import { AutomationDestinationField } from './AutomationDestinationField'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import type { AutomationDraft } from './AutomationEditorDialog'
import type { Bot } from '../../../../../shared/bot-types'
import { AutomationBotTargetFields } from './AutomationBotTargetFields'
import { AutomationBotAgentField } from './AutomationBotAgentField'
import { AutomationBotEventsField } from './AutomationBotEventsField'
import { openBotHomeTab, useBotThreadReplies } from '@/lib/bot-catalog'
import { isSameBot, type BotRef } from '@/lib/bot-hosts'
import { botEventsHaveThreads } from '../../../../../shared/automations/bot-automation-target-edit'

const SETTINGS_SIDEBAR_CLASS =
  'flex w-[320px] shrink-0 flex-col overflow-auto border-l border-border/50 bg-muted/20 px-5 py-5 scrollbar-sleek @max-[35rem]:w-full @max-[35rem]:overflow-visible @max-[35rem]:border-t @max-[35rem]:border-l-0'

type AutomationEditorSettingsSidebarProps = {
  /** The host picker: where a create lands, or the host an edit can move the record to. */
  launchWorkspace?: ProspectiveWorkspace
  launchAuthority?: AutomationAuthorityRef
  surface: 'chat' | 'terminal'
  chatSupported: boolean | null
  destination?: AutomationCreateDestinationControl
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
  automationYamlHooksByRepoKey: Record<string, OrcaHooks | null>
  getAutomationHooksCacheKey: (repoId: string) => string
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  settings: GlobalSettings | null
  draft: AutomationDraft
  visibleAgents: AgentCatalogEntry[]
  pickerTriggerClassName: string
  onProjectChange: (projectId: string) => void
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
  allowAddProject?: boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onSetupDecisionTouched: () => void
  /** Bots this computer can run an automation as. */
  bots: readonly Bot[]
  isEditing: boolean
  onClose: () => void
}

export function AutomationEditorSettingsSidebar({
  destination,
  launchWorkspace,
  launchAuthority,
  surface,
  chatSupported,
  repos,
  projectHostSetups,
  automationYamlHooksByRepoKey,
  getAutomationHooksCacheKey,
  repoMap,
  worktrees,
  settings,
  draft,
  visibleAgents,
  pickerTriggerClassName,
  onProjectChange,
  getRepoHostLabel,
  allowAddProject,
  onDraftChange,
  onSetupDecisionTouched,
  bots,
  isEditing,
  onClose
}: AutomationEditorSettingsSidebarProps): React.JSX.Element {
  const t = useTranslate()
  const updateCodexId = useId()
  const botTarget = draft.bot
  // Edit drafts carry no botHostId, so they match by id alone.
  const targetBot = botTarget
    ? (bots.find(
        (entry) =>
          entry.id === botTarget.botId &&
          (draft.botHostId === undefined || entry.hostId === draft.botHostId)
      ) ?? null)
    : null
  const threadReplies = useBotThreadReplies(targetBot?.hostId ?? null)
  const selectBot = (ref: BotRef): void => {
    const bot = bots.find((entry) => isSameBot(entry, ref))
    if (!bot || (targetBot && isSameBot(bot, targetBot))) {
      return
    }
    onDraftChange((current) => ({
      ...current,
      botHostId: bot.hostId,
      bot: {
        botId: bot.id,
        runsIn: current.bot?.runsIn ?? 'new',
        resultsTo: current.bot?.resultsTo ?? 'chat',
        ...(current.bot?.letBotReact ? { letBotReact: true } : {})
      },
      // The bot brings its own agent, folder and session.
      agentId: bot.agent,
      extraAgentArgs: '',
      projectId: '',
      workspaceMode: 'existing',
      workspaceId: '',
      reuseSession: false,
      updateCodexBeforeRun: false
    }))
  }
  // A saved automation cannot move between a bot and a project, so an edit offers only its own kind.
  const offeredBots = isEditing && !botTarget ? [] : bots
  const targetPicker = (
    <Field
      className="mb-4"
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={
        offeredBots.length > 0
          ? t('automations.botTarget.fieldLabel', 'Bot or project')
          : t('auto.components.automations.AutomationEditorDialog.02d351877e', 'Project')
      }
    >
      <AutomationProjectCombobox
        repos={isEditing && botTarget ? [] : repos}
        recordedProject={destination?.recordedProject}
        value={draft.projectId}
        onValueChange={(projectId) => {
          onDraftChange((current) => ({ ...current, bot: null, botHostId: undefined }))
          onProjectChange(projectId)
        }}
        placeholder={
          offeredBots.length > 0
            ? t('automations.botTarget.fieldPlaceholder', 'Select bot or project')
            : t('auto.components.automations.AutomationEditorDialog.0d17f4ca8f', 'Select project')
        }
        triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
        getRepoHostLabel={getRepoHostLabel}
        allowAddProject={isEditing && botTarget ? false : allowAddProject}
        bots={offeredBots}
        selectedBot={targetBot}
        onBotChange={selectBot}
      />
    </Field>
  )
  const schedulePicker = (label: string, onSetUpEvents?: () => void) => (
    <Field className="mb-4" labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={label}>
      <AutomationSchedulePicker
        draft={draft}
        validateAdvancedSchedule={isValidAutomationSchedule}
        onDraftChange={onDraftChange}
        onSetUpEvents={onSetUpEvents}
      />
    </Field>
  )
  if (botTarget) {
    const saved = draft.savedBotAutomation
    // Events are set up by chatting with the bot that owns the saved automation, or for a new one, the picked bot.
    const chatBot = saved ? (bots.find((entry) => entry.id === saved.botId) ?? null) : targetBot
    const askInChat = chatBot
      ? (sentence: string): void => {
          onClose()
          void openBotHomeTab(chatBot, { draft: sentence })
        }
      : null
    return (
      <aside className={SETTINGS_SIDEBAR_CLASS}>
        {targetPicker}
        {schedulePicker(
          t('automations.botTarget.when', 'When'),
          askInChat
            ? () =>
                askInChat(
                  saved
                    ? t(
                        'automations.botEvents.addDraft',
                        'Change the automation “{{name}}” so it also runs when ',
                        { name: saved.name }
                      )
                    : t('automations.botEvents.newDraft', 'Set up an automation that runs when ')
                )
            : undefined
        )}
        {saved?.on.length ? (
          <AutomationBotEventsField
            triggers={saved.on}
            onEditInChat={
              askInChat
                ? () =>
                    askInChat(
                      t('automations.botEvents.editDraft', 'Change the automation “{{name}}”: ', {
                        name: saved.name
                      })
                    )
                : undefined
            }
          />
        ) : null}
        <AutomationBotTargetFields
          target={botTarget}
          bot={targetBot}
          agentField={
            targetBot ? (
              <AutomationBotAgentField
                target={botTarget}
                bot={targetBot}
                onChange={(bot) => onDraftChange((current) => ({ ...current, bot }))}
              />
            ) : null
          }
          threadReplies={threadReplies}
          hasEventThread={botEventsHaveThreads(draft.eventsOnly === true, saved?.on ?? [])}
          onChange={(bot) => onDraftChange((current) => ({ ...current, bot }))}
        />
      </aside>
    )
  }
  return (
    <aside className={SETTINGS_SIDEBAR_CLASS}>
      <div className="flex flex-col">
        <div className="mb-4 flex flex-col gap-5">
          <Field
            labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
            label={t('auto.components.automations.AutomationEditorDialog.57b722cbba', 'Agent')}
          >
            <AutomationAgentLaunchPicker
              draft={draft}
              authority={launchAuthority}
              workspace={
                launchWorkspace ?? {
                  kind: 'git-worktree',
                  repoId: draft.projectId,
                  worktreeId: draft.workspaceId || undefined
                }
              }
              visibleAgents={visibleAgents}
              settings={settings}
              surface={surface}
              chatSupported={chatSupported}
              onDraftChange={onDraftChange}
            />
          </Field>
          {draft.agentId === 'codex' && (
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <label htmlFor={updateCodexId} className="text-sm font-medium">
                  {t('automations.updateCodex.label', 'Update Codex before running')}
                </label>
                <p id={`${updateCodexId}-help`} className="text-xs text-muted-foreground">
                  {t(
                    'automations.updateCodex.help',
                    'Check for updates and start a fresh Codex session for each run.'
                  )}
                </p>
              </div>
              <Switch
                id={updateCodexId}
                aria-describedby={`${updateCodexId}-help`}
                checked={draft.updateCodexBeforeRun === true}
                onCheckedChange={(updateCodexBeforeRun) =>
                  onDraftChange((current) => ({
                    ...current,
                    updateCodexBeforeRun,
                    ...(updateCodexBeforeRun ? { reuseSession: false } : {})
                  }))
                }
              />
            </div>
          )}
        </div>
        {destination ? (
          <div className="mb-4">
            <AutomationDestinationField
              control={destination}
              labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
              hasBots={offeredBots.length > 0}
            />
          </div>
        ) : null}
        {targetPicker}
        <div className="mb-4">
          <AutomationWorkspaceField
            draft={draft}
            worktrees={worktrees}
            repoMap={repoMap}
            pickerTriggerClassName={pickerTriggerClassName}
            onDraftChange={onDraftChange}
          />
        </div>
        <div className="mb-4">
          <AutomationSessionField draft={draft} onDraftChange={onDraftChange} />
        </div>
        {schedulePicker(
          t('auto.components.automations.AutomationEditorDialog.c4b19094c2', 'Schedule')
        )}
        <div className="mb-4">
          <AutomationMissedRunGraceField
            disabled={false}
            draft={draft}
            pickerTriggerClassName={pickerTriggerClassName}
            onDraftChange={onDraftChange}
          />
        </div>
        <div className="mb-4">
          <div className="flex flex-col gap-5">
            <AutomationPrecheckFields
              disabled={false}
              draft={draft}
              pickerTriggerClassName={pickerTriggerClassName}
              onDraftChange={onDraftChange}
            />
          </div>
        </div>
        <AutomationSetupDecisionField
          draft={draft}
          repos={repos}
          projectHostSetups={projectHostSetups}
          yamlHooks={automationYamlHooksByRepoKey[getAutomationHooksCacheKey(draft.projectId)]}
          onDraftChange={onDraftChange}
          onSetupDecisionTouched={onSetupDecisionTouched}
        />
      </div>
    </aside>
  )
}
