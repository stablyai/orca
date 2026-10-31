import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  SourceControlAiSettingsPatch,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import { buildBranchNamePrompt } from '../../../../shared/branch-name-from-work'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import {
  resolveSourceControlActionCommandTemplate,
  setSourceControlActionDefault
} from '../../../../shared/source-control-ai-actions'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Switch } from '../ui/switch'
import { getAutoRenameBranchAdvancedSearchEntries } from './auto-rename-branch-search'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from './settings-search'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'

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
  const storeSearchQuery = useAppStore((state) => state.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery
  const config = readSourceControlSettings(settings)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const advancedSearchOpen = shouldOpenAutoRenameBranchAdvanced(searchQuery)
  const advancedOpen = optionsOpen || advancedSearchOpen
  const persistedBranchNameTemplate = resolveSourceControlActionCommandTemplate(
    config.actions,
    'branchName'
  )
  const persistedBranchNameTemplateRef = useRef(persistedBranchNameTemplate)
  persistedBranchNameTemplateRef.current = persistedBranchNameTemplate
  const [branchNameTemplateDraft, setBranchNameTemplateDraft] = useState(
    persistedBranchNameTemplate
  )
  const [isSavingPrompt, setIsSavingPrompt] = useState(false)
  const branchNamePromptDirty = branchNameTemplateDraft !== persistedBranchNameTemplate

  useEffect(() => {
    if (!branchNamePromptDirty) {
      setBranchNameTemplateDraft(persistedBranchNameTemplate)
    }
  }, [branchNamePromptDirty, persistedBranchNameTemplate])

  useEffect(() => {
    setBranchNameTemplateDraft(persistedBranchNameTemplateRef.current)
    // Settings owns discard confirmation; keep the draft here for row-specific save/discard controls.
  }, [branchPromptDiscardSignal])

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
      title={translate(
        'auto.components.settings.AutoRenameBranchFromWorkSetting.ef787db0e3',
        'Auto-rename branch & worktree'
      )}
      description={translate(
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
        'slug'
      ]}
      forceVisible={forceVisible || branchNamePromptDirty || advancedSearchOpen}
      className="space-y-3 py-2"
    >
      <div ref={setSettingRootRef} className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.AutoRenameBranchFromWorkSetting.ef787db0e3',
              'Auto-rename branch & worktree'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AutoRenameBranchFromWorkSetting.12ea4a408d',
              'When an agent starts working in a new workspace, Orca renames its auto-generated branch (e.g.'
            )}{' '}
            <code>
              {translate(
                'auto.components.settings.AutoRenameBranchFromWorkSetting.1626524572',
                'Nautilus'
              )}
            </code>
            {translate(
              'auto.components.settings.AutoRenameBranchFromWorkSetting.d9b65054ef',
              ') to a short name summarizing the task. Only branches Orca named itself are renamed, and never after they have been pushed.'
            )}
          </p>
        </div>
        <Switch
          aria-label={translate(
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

      <Collapsible open={advancedOpen} onOpenChange={setOptionsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate(
              'auto.components.settings.AutoRenameBranchFromWorkSetting.e784ea62dc',
              'Advanced'
            )}
            <ChevronDown
              className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-180')}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
            <div className="space-y-2">
              <div className="space-y-0.5">
                <Label htmlFor="git-auto-rename-branch-name-template">
                  {translate(
                    'auto.components.settings.AutoRenameBranchFromWorkSetting.a869d0edd8',
                    'Branch name command template'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  <Trans
                    i18n={i18n}
                    defaults={translate(
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
                placeholder={translate(
                  'auto.components.settings.AutoRenameBranchFromWorkSetting.c71770c455',
                  '{basePrompt}'
                )}
                className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
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
                    ? translate(
                        'auto.components.settings.AutoRenameBranchFromWorkSetting.7c7e34a66d',
                        'Unsaved changes'
                      )
                    : translate(
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
                      {translate(
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
                      ? translate(
                          'auto.components.settings.AutoRenameBranchFromWorkSetting.cfd82406dd',
                          'Saving...'
                        )
                      : translate(
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
