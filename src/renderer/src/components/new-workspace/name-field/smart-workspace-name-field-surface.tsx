import React from 'react'
import { Button } from '@/components/ui/button'
import { Command } from '@/components/ui/command'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { SmartWorkspaceSourceTabs } from '../source-search/SmartWorkspaceSourceTabs'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { WorkspaceEmojiSuggestionPopover } from '@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover'
import { renderSmartWorkspaceCrossRepoDialog } from './smart-workspace-cross-repo-dialog'
import { renderSmartWorkspaceNameInput } from './smart-workspace-name-input-surface'
import { renderSmartWorkspaceSourceResults } from './smart-workspace-source-results-surface'
import { getJiraSourceStatusMessage } from '../source-search/jira-source-status-message'
import type { SmartWorkspaceNameFieldController } from './use-smart-workspace-name-field-controller'

export function renderSmartWorkspaceNameField(
  controller: SmartWorkspaceNameFieldController,
  t: Translate = translate
): React.JSX.Element {
  const {
    mode,
    localInputRef,
    disabled,
    selectedSource,
    open,
    handleSourcePopoverOpenChange,
    resolvedCommandValue,
    isQueryStale,
    setCommandValue,
    jiraSource,
    jiraStatusId,
    linearStatusId,
    unresolvedLinearUrlIntent,
    onOpenJiraSettings,
    emojiMenuOpen,
    resolvedEmojiCommandValue,
    emojiSuggestions,
    setEmojiCommandValue,
    handleEmojiSelect,
    setEmojiCursor
  } = controller

  return (
    <div className="min-w-0 space-y-1.5">
      {controller.textOnly ? null : (
        <SmartWorkspaceSourceTabs
          model={controller}
          onModeChange={controller.handleModeChange}
          inputRef={controller.localInputRef}
          tabsListRef={controller.tabsListRef}
        />
      )}
      <Popover
        open={!disabled && open && mode !== 'text' && selectedSource === null}
        onOpenChange={handleSourcePopoverOpenChange}
      >
        <Command
          value={resolvedCommandValue}
          onValueChange={(next) => {
            // cmdk re-emits on row reshapes; freeze selection while debounce trails the input.
            if (isQueryStale) {
              return
            }
            setCommandValue(next)
          }}
          shouldFilter={false}
          className="overflow-visible bg-transparent"
        >
          <PopoverAnchor asChild>
            <div className="relative min-w-0">{renderSmartWorkspaceNameInput(controller, t)}</div>
          </PopoverAnchor>
          {renderSmartWorkspaceSourceResults(controller, t)}
        </Command>
      </Popover>
      {jiraSource.intent ? (
        <div
          id={jiraStatusId}
          role="status"
          aria-live="polite"
          className={cn(
            'flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground',
            !jiraSource.loading &&
              !jiraSource.errorKind &&
              jiraSource.accountChoices.length === 0 &&
              'sr-only'
          )}
        >
          <span>{getJiraSourceStatusMessage(jiraSource, t)}</span>
          {jiraSource.errorKind === 'disconnected' && onOpenJiraSettings ? (
            <Button type="button" variant="link" size="xs" onClick={onOpenJiraSettings}>
              {t('auto.components.new.workspace.SmartWorkspaceNameField.openSettings', 'Settings')}
            </Button>
          ) : jiraSource.errorKind === 'read-failed' ? (
            <Button type="button" variant="link" size="xs" onClick={jiraSource.retry}>
              {t('auto.components.new.workspace.SmartWorkspaceNameField.retryJira', 'Retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {unresolvedLinearUrlIntent ? (
        <div id={linearStatusId} role="status" aria-live="polite" className="sr-only">
          {t(
            'auto.components.new.workspace.SmartWorkspaceNameField.loadingLinearIssue',
            'Loading Linear issue…'
          )}
        </div>
      ) : null}
      <WorkspaceEmojiSuggestionPopover
        anchorRef={localInputRef}
        open={emojiMenuOpen}
        commandValue={resolvedEmojiCommandValue}
        heading={t('auto.components.new.workspace.SmartWorkspaceNameField.emoji', 'Emoji')}
        suggestions={emojiSuggestions}
        onCommandValueChange={setEmojiCommandValue}
        onSelect={handleEmojiSelect}
        onOpenChange={(next) => {
          if (!next) {
            setEmojiCursor(null)
          }
        }}
      />
      {renderSmartWorkspaceCrossRepoDialog(controller, t)}
    </div>
  )
}
