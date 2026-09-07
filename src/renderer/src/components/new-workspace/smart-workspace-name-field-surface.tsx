import React from 'react'
import { Button } from '@/components/ui/button'
import { Command } from '@/components/ui/command'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { WorkspaceEmojiSuggestionPopover } from '@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover'
import { renderSmartWorkspaceCrossRepoDialog } from './smart-workspace-cross-repo-dialog'
import { renderSmartWorkspaceNameInput } from './smart-workspace-name-input-surface'
import { renderSmartWorkspaceSourceResults } from './smart-workspace-source-results-surface'
import type { JiraUrlSourceState } from './use-jira-url-source'
import type { SmartWorkspaceNameFieldController } from './use-smart-workspace-name-field-controller'

function getJiraSourceStatusMessage(jiraSource: JiraUrlSourceState): string {
  if (jiraSource.loading) {
    return translate(
      'auto.components.new.workspace.SmartWorkspaceNameField.loadingJira',
      'Loading Jira issue…'
    )
  }
  switch (jiraSource.errorKind) {
    case 'disconnected':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.jiraDisconnected',
        'Connect Jira in Settings to link this issue'
      )
    case 'site-not-connected':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.jiraSiteNotConnected',
        'This Jira site is not connected'
      )
    case 'update-runtime':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.jiraRuntimeUpdate',
        'Update the remote runtime to link Jira'
      )
    case 'read-failed':
      return translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.jiraReadFailed',
        'Couldn’t load this Jira issue'
      )
    case null:
      return jiraSource.accountChoices.length > 0
        ? translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.chooseJiraAccount',
            'Choose a Jira account'
          )
        : translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.jiraLoaded',
            'Jira issue loaded'
          )
  }
}

export function renderSmartWorkspaceNameField(
  controller: SmartWorkspaceNameFieldController
): React.JSX.Element {
  const {
    textOnly,
    mode,
    onActiveSourceModeChange,
    setMode,
    disabled,
    selectedSource,
    markSourcePopoverUserEngaged,
    setOpen,
    cancelLocalInputFocusFrame,
    localInputFocusFrameRef,
    localInputRef,
    tabsListRef,
    availableModes,
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
      {textOnly ? null : (
        <div className="flex min-w-0 items-center gap-2 border-b border-border/40">
          <Tabs
            value={mode}
            onValueChange={(next) => {
              const nextMode = next as typeof mode
              onActiveSourceModeChange?.(nextMode)
              setMode(nextMode)
              if (!disabled && nextMode !== 'text' && selectedSource === null) {
                markSourcePopoverUserEngaged()
                setOpen(true)
              } else {
                setOpen(false)
              }
              cancelLocalInputFocusFrame()
              localInputFocusFrameRef.current = requestAnimationFrame(() => {
                localInputFocusFrameRef.current = null
                localInputRef.current?.focus({ preventScroll: true })
              })
            }}
            className="min-w-0 flex-1 gap-0"
          >
            <TabsList
              ref={tabsListRef}
              variant="line"
              className="h-7 w-full justify-start gap-4 overflow-x-auto overflow-y-hidden px-0 scrollbar-sleek"
              onFocusCapture={(event) => {
                // Why: Radix roving focus races commits, so forward external Tab focus to the input.
                const previous = event.relatedTarget as HTMLElement | null
                const list = tabsListRef.current
                const input = localInputRef.current
                if (!list || !input) {
                  return
                }
                if (!previous || previous === input || list.contains(previous)) {
                  return
                }
                event.stopPropagation()
                input.focus({ preventScroll: true })
              }}
            >
              {availableModes.map(({ id, label, Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  tabIndex={-1}
                  data-smart-name-mode={id}
                  className="flex-none gap-1.5 px-0 text-xs"
                >
                  <Icon className="size-3.5" />
                  <span>{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}
      <Popover
        open={!disabled && open && mode !== 'text' && selectedSource === null}
        onOpenChange={handleSourcePopoverOpenChange}
      >
        <Command
          value={resolvedCommandValue}
          onValueChange={(next) => {
            // Why: cmdk re-emits when rows reshape; freeze it while debounce trails input.
            if (isQueryStale) {
              return
            }
            setCommandValue(next)
          }}
          shouldFilter={false}
          className="overflow-visible bg-transparent"
        >
          <PopoverAnchor asChild>
            <div className="relative min-w-0">{renderSmartWorkspaceNameInput(controller)}</div>
          </PopoverAnchor>
          {renderSmartWorkspaceSourceResults(controller)}
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
          <span>{getJiraSourceStatusMessage(jiraSource)}</span>
          {jiraSource.errorKind === 'disconnected' && onOpenJiraSettings ? (
            <Button type="button" variant="link" size="xs" onClick={onOpenJiraSettings}>
              {translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.openSettings',
                'Settings'
              )}
            </Button>
          ) : jiraSource.errorKind === 'read-failed' ? (
            <Button type="button" variant="link" size="xs" onClick={jiraSource.retry}>
              {translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.retryJira',
                'Retry'
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
      {unresolvedLinearUrlIntent ? (
        <div id={linearStatusId} role="status" aria-live="polite" className="sr-only">
          {translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.loadingLinearIssue',
            'Loading Linear issue…'
          )}
        </div>
      ) : null}
      <WorkspaceEmojiSuggestionPopover
        anchorRef={localInputRef}
        open={emojiMenuOpen}
        commandValue={resolvedEmojiCommandValue}
        heading={translate('auto.components.new.workspace.SmartWorkspaceNameField.emoji', 'Emoji')}
        suggestions={emojiSuggestions}
        onCommandValueChange={setEmojiCommandValue}
        onSelect={handleEmojiSelect}
        onOpenChange={(next) => {
          if (!next) {
            setEmojiCursor(null)
          }
        }}
      />
      {renderSmartWorkspaceCrossRepoDialog(controller)}
    </div>
  )
}
