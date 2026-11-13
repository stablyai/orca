import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type {
  SourceControlAiSettingsPatch,
  SourceControlAiSettings
} from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { buildBranchNamePrompt } from '../../../../../shared/source-control/ai/naming/branch-name-from-work'
import { normalizeSourceControlAiSettings } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import {
  resolveSourceControlActionCommandTemplate,
  setSourceControlActionDefault
} from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { cn } from '@/lib/class-names'
import { useAppStore } from '../../../store/index'
import { Button } from '../../ui/button'
import { SourceControlActionVariableChips } from '../../source-control/SourceControlActionVariableChips'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import { Label } from '../../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Switch } from '../../ui/switch'
import {
  AUTO_RENAME_BRANCH_TEMPLATE_SETTING_ID,
  getAutoRenameBranchAdvancedSearchEntries,
  getWorkspaceTitleLanguageSearchEntry
} from './auto-rename-branch-search'
import { useSettingsTargetReveal } from '../section-layout/settings-target-highlight'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from '../search/settings-search'
import { Trans } from 'react-i18next'
import { WorkspaceTitleLanguageSetting } from './WorkspaceTitleLanguageSetting'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

type AutoRenameBranchFromWorkSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  forceVisible?: boolean
  onBranchPromptDirtyChange?: (dirty: boolean) => void
  branchPromptDiscardSignal?: number
  settingsSearchQuery?: string
}

const BUILT_IN_BRANCH_NAME_PROMPT = buildBranchNamePrompt({
  firstPrompt: '{first agent prompt}',
  assistantMessage: '{agent initial response, when available}'
})
export function shouldOpenAutoRenameBranchAdvanced(searchQuery: string): boolean {
  return (
    normalizeSettingsSearchQuery(searchQuery) !== '' &&
    matchesSettingsSearch(searchQuery, getAutoRenameBranchAdvancedSearchEntries())
  )
}

function readSourceControlSettings(settings: GlobalSettings): SourceControlAiSettings {
  return normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi)
}

export function AutoRenameBranchFromWorkSetting({
  settings,
  updateSettings,
  writeSourceControlAiSettings,
  forceVisible = false,
  onBranchPromptDirtyChange,
  branchPromptDiscardSignal,
  settingsSearchQuery
}: AutoRenameBranchFromWorkSettingProps): React.JSX.Element {
  const t = useTranslate()
  const storeSearchQuery = useAppStore((state) => state.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery
  const config = readSourceControlSettings(settings)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const advancedRevealRef = useSettingsTargetReveal<HTMLDivElement>(() => setOptionsOpen(true))
  const advancedSearchOpen = shouldOpenAutoRenameBranchAdvanced(searchQuery)
  const advancedOpen = optionsOpen || advancedSearchOpen
  const persistedBranchNameTemplate = resolveSourceControlActionCommandTemplate(
    config.actions,
    'branchName'
  )
  const [branchNameTemplateDraft, setBranchNameTemplateDraft] = useState(
    persistedBranchNameTemplate
  )
  const [isSavingPrompt, setIsSavingPrompt] = useState(false)
  const branchNamePromptDirty = branchNameTemplateDraft !== persistedBranchNameTemplate

  // Settings owns discard confirmation; keep the draft here for row-specific save/discard controls.
  const [seenDiscardSignal, setSeenDiscardSignal] = useState(branchPromptDiscardSignal)
  if (seenDiscardSignal !== branchPromptDiscardSignal) {
    setSeenDiscardSignal(branchPromptDiscardSignal)
    setBranchNameTemplateDraft(persistedBranchNameTemplate)
  }

  useEffect(() => {
    onBranchPromptDirtyChange?.(branchNamePromptDirty)
  }, [branchNamePromptDirty, onBranchPromptDirtyChange])

  const onBranchPromptDirtyChangeRef = useRef(onBranchPromptDirtyChange)
  onBranchPromptDirtyChangeRef.current = onBranchPromptDirtyChange
  const setSettingRootRef = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) {
      return
    }
    // Clear Settings’ global dirty guard when this row detaches.
    onBranchPromptDirtyChangeRef.current?.(false)
  }, [])

  const onSavePrompt = async (): Promise<void> => {
    if (!branchNamePromptDirty || isSavingPrompt) {
      return
    }
    setIsSavingPrompt(true)
    try {
      await writeSourceControlAiSettings((current) => ({
        actions: setSourceControlActionDefault(current.actions, 'branchName', {
          commandInputTemplate: branchNameTemplateDraft
        })
      }))
    } finally {
      setIsSavingPrompt(false)
    }
  }

  const onDiscardPrompt = (): void => {
    setBranchNameTemplateDraft(persistedBranchNameTemplate)
  }

  return (
    <SearchableSetting
      title={t(
        'auto.components.settings.AutoRenameBranchFromWorkSetting.ef787db0e3',
        'Auto-rename branch & worktree'
      )}
      description={t(
        'auto.components.settings.AutoRenameBranchFromWorkSetting.6a051586d2',
        'Rename the auto-generated branch based on the work once an agent starts.'
      )}
      keywords={[
        'branch',
        'rename',
        'auto',
        'creature name',
        'agent',
        'prompt',
        'command',
        'template',
        'worktree',
        'slug',
        ...(getWorkspaceTitleLanguageSearchEntry().keywords ?? [])
      ]}
      forceVisible={forceVisible || branchNamePromptDirty || advancedSearchOpen}
      className="space-y-3 py-3"
    >
      <div ref={setSettingRootRef} className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label>
            {t(
              'auto.components.settings.AutoRenameBranchFromWorkSetting.ef787db0e3',
              'Auto-rename branch & worktree'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.AutoRenameBranchFromWorkSetting.12ea4a408d',
              'When an agent starts working in a new workspace, Orca renames its auto-generated branch (e.g.'
            )}{' '}
            <code>
              {t('auto.components.settings.AutoRenameBranchFromWorkSetting.1626524572', 'Nautilus')}
            </code>
            {t(
              'auto.components.settings.AutoRenameBranchFromWorkSetting.d9b65054ef',
              ') to a short name summarizing the task. Only branches Orca named itself are renamed, and never after they have been pushed.'
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            'auto.components.settings.AutoRenameBranchFromWorkSetting.ef787db0e3',
            'Auto-rename branch & worktree'
          )}
          checked={settings.autoRenameBranchFromWork}
          onCheckedChange={(checked) =>
            updateSettings({
              autoRenameBranchFromWork: checked
            })
          }
        />
      </div>

      <WorkspaceTitleLanguageSetting settings={settings} updateSettings={updateSettings} />

      <Collapsible ref={advancedRevealRef} open={advancedOpen} onOpenChange={setOptionsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('auto.components.settings.AutoRenameBranchFromWorkSetting.e784ea62dc', 'Advanced')}
            <ChevronDown
              className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-180')}
            />
          </Button>
        </CollapsibleTrigger>
        {/* Mounted while closed so a settings jump can find and reveal the template. */}
        <CollapsibleContent forceMount className="data-[state=closed]:hidden">
          <div className="mt-2 space-y-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
            <div id={AUTO_RENAME_BRANCH_TEMPLATE_SETTING_ID} className="space-y-2">
              <div className="space-y-0.5">
                <Label htmlFor="git-auto-rename-branch-name-template">
                  {t(
                    'auto.components.settings.AutoRenameBranchFromWorkSetting.a869d0edd8',
                    'Branch name command template'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  <Trans
                    i18n={i18n}
                    defaults={t(
                      'auto.components.settings.AutoRenameBranchFromWorkSetting.commandTemplateDescription',
                      "Use <basePrompt>{basePrompt}</basePrompt> to include Orca's <promptLink>built-in branch-name prompt</promptLink>. You can also reference <firstPrompt>{firstPrompt}</firstPrompt> and <assistantMessage>{assistantMessage}</assistantMessage>. Orca generates only the final segment, like <example>fix-login-flow</example>; your branch prefix setting still applies."
                    )}
                    components={{
                      basePrompt: <code className="font-mono" />,
                      promptLink: <BuiltInBranchNamePromptLink />,
                      firstPrompt: <code className="font-mono" />,
                      assistantMessage: <code className="font-mono" />,
                      example: <code className="font-mono" />
                    }}
                  />
                </p>
              </div>
              <textarea
                id="git-auto-rename-branch-name-template"
                rows={4}
                value={branchNameTemplateDraft}
                onChange={(event) => setBranchNameTemplateDraft(event.target.value)}
                placeholder={t(
                  'auto.components.settings.AutoRenameBranchFromWorkSetting.c71770c455',
                  '{basePrompt}'
                )}
                className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              />
              <SourceControlActionVariableChips
                actionId="branchName"
                onInsert={(variable) => {
                  const separator =
                    branchNameTemplateDraft.endsWith('\n') || branchNameTemplateDraft.length === 0
                      ? ''
                      : ' '
                  setBranchNameTemplateDraft(`${branchNameTemplateDraft}${separator}{${variable}}`)
                }}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-muted-foreground">
                  {branchNamePromptDirty
                    ? t(
                        'auto.components.settings.AutoRenameBranchFromWorkSetting.7c7e34a66d',
                        'Unsaved changes'
                      )
                    : t(
                        'auto.components.settings.AutoRenameBranchFromWorkSetting.40e7be7850',
                        'Saved'
                      )}
                </p>
                <div className="flex items-center gap-2">
                  {branchNamePromptDirty ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={onDiscardPrompt}
                      disabled={isSavingPrompt}
                    >
                      {t(
                        'auto.components.settings.AutoRenameBranchFromWorkSetting.0de9fda203',
                        'Discard'
                      )}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => void onSavePrompt()}
                    disabled={!branchNamePromptDirty || isSavingPrompt}
                  >
                    {isSavingPrompt
                      ? t(
                          'auto.components.settings.AutoRenameBranchFromWorkSetting.cfd82406dd',
                          'Saving...'
                        )
                      : t(
                          'auto.components.settings.AutoRenameBranchFromWorkSetting.ec3e0c388e',
                          'Save'
                        )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SearchableSetting>
  )
}

function BuiltInBranchNamePromptLink({
  children
}: {
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-[520px] max-w-[calc(100vw-2rem)] p-3"
      >
        <div>
          <pre className="scrollbar-sleek max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {BUILT_IN_BRANCH_NAME_PROMPT}
          </pre>
        </div>
      </PopoverContent>
    </Popover>
  )
}
