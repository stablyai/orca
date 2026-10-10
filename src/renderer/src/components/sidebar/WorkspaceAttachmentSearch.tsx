import React, { useCallback, useId, useMemo, useState } from 'react'
import { ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import type { RowEntry } from '../new-workspace/smart-workspace-name-field-model'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'
import { useWorkItemSourceSearch } from '../new-workspace/use-work-item-source-search'
import { SmartWorkspaceSourceTabs } from '../new-workspace/SmartWorkspaceSourceTabs'
import { SmartWorkspaceSourceResultList } from '../new-workspace/SmartWorkspaceSourceResultList'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import {
  ATTACHMENT_INPUT_KINDS,
  isAttachmentInputKind,
  parseWorkspaceAttachmentInput,
  workspaceAttachmentLabel,
  type AttachmentInputKind
} from './worktree-attachment-editing'
import {
  getWorkspaceAttachmentSourceContext,
  matchesWorkspaceAttachmentQuery,
  isWorkspaceAttachmentLinked
} from './workspace-attachment-source-result'

import type { WorkspaceAttachmentComposerProps } from './WorkspaceAttachmentComposer'
import { WorkspaceAttachmentSourceStatus } from './WorkspaceAttachmentSourceStatus'

export function WorkspaceAttachmentSearch({
  query,
  onQueryChange,
  kind,
  onKindChange,
  onRetry,
  ...props
}: Omit<WorkspaceAttachmentComposerProps, 'onQueryChange'> & {
  query: string
  onQueryChange: (value: string) => void
  kind: AttachmentInputKind
  onKindChange: (kind: AttachmentInputKind) => void
  onRetry: () => void
}): React.JSX.Element {
  const [selection, setSelection] = useState('')
  const inputId = useId()
  const contexts = useMemo(
    () => ({
      github: getWorkspaceAttachmentSourceContext('github', props.repo, props.workspace),
      gitlab: getWorkspaceAttachmentSourceContext('gitlab', props.repo, props.workspace),
      linear: getWorkspaceAttachmentSourceContext('linear', props.repo, props.workspace),
      jira: getWorkspaceAttachmentSourceContext('jira', props.repo, props.workspace)
    }),
    [props.repo, props.workspace]
  )
  const repos = useMemo(() => (props.repo ? [props.repo] : []), [props.repo])
  const add = (item: WorkspaceAttachment): void => {
    if (!props.onAdd(item)) {
      return
    }
    onQueryChange('')
    setSelection('')
    props.inputRef.current?.focus()
  }
  const changeMode = useCallback(
    (mode: SmartNameMode): void => {
      if (mode === 'linear') {
        onKindChange('linear-issue')
      } else if (mode === 'jira') {
        onKindChange('jira-issue')
      } else if (mode === 'gitlab') {
        onKindChange(kind === 'gitlab-issue' ? 'gitlab-issue' : 'gitlab-mr')
      } else if (mode === 'github' && kind !== 'github-pr' && kind !== 'github-issue') {
        onKindChange('github-issue')
      }
    },
    [kind, onKindChange]
  )
  const controller = useWorkItemSourceSearch({
    repos,
    disabled: props.disabled,
    repoId: props.repo?.id ?? '',
    value: query,
    branchesEnabled: false,
    repoBackedSourcesDisabled: !props.repo,
    crossRepoSwitchTarget: 'task-source',
    githubSourceContext: contexts.github,
    linearSourceContext: contexts.linear,
    gitlabSourceContext: contexts.gitlab,
    jiraSourceContext: contexts.jira
  })
  const toAttachment = controller.resolveRow
  const linked = (row: RowEntry): boolean => {
    const item = toAttachment(row)
    return item ? isWorkspaceAttachmentLinked(props.items, item) : false
  }
  const selectRow = (row: RowEntry): void => {
    if (controller.isQueryStale) {
      return
    }
    if (row.kind === 'jira-account') {
      controller.selectJiraAccount(row.site.id)
      return
    }
    const item = toAttachment(row)
    if (item && !isWorkspaceAttachmentLinked(props.items, item)) {
      add(item)
    }
  }
  const rows = controller.rows
  const parsedDirect = parseWorkspaceAttachmentInput(query, kind)
  const resolvedDirectRow =
    !controller.isQueryStale && parsedDirect
      ? rows.find((row) => {
          const item = toAttachment(row)
          return item ? matchesWorkspaceAttachmentQuery(parsedDirect, item) : false
        })
      : null
  const direct = resolvedDirectRow
    ? (toAttachment(resolvedDirectRow) ?? parsedDirect)
    : parsedDirect
  const directLinked = direct ? isWorkspaceAttachmentLinked(props.items, direct) : false
  const scopeError = direct ? props.getScopeError(direct) : null
  const directValue = direct ? `attachment-direct:${getWorkspaceAttachmentKey(direct)}` : ''
  const ambiguousNumber = /^#?\d+$/.test(query.trim())
  const taskUrlProvider =
    /^https?:\/\//i.test(query.trim()) &&
    (parsedDirect?.provider === 'linear' || parsedDirect?.provider === 'jira')
      ? parsedDirect.provider
      : null
  const directEnabled = Boolean(
    direct &&
    !props.disabled &&
    !directLinked &&
    !scopeError &&
    !controller.blockingTaskUrlResolution &&
    (!taskUrlProvider || resolvedDirectRow) &&
    (taskUrlProvider !== 'jira' ||
      (!controller.jiraSource.loading && !controller.jiraSource.errorKind)) &&
    !controller.unresolvedLinearUrlIntent &&
    (!ambiguousNumber || (!controller.isQueryStale && !controller.loading))
  )
  const actionableRows = controller.isQueryStale ? [] : rows.filter((row) => !linked(row))
  const commandValue =
    selection === directValue && directEnabled
      ? directValue
      : actionableRows.some((row) => row.value === selection)
        ? selection
        : directEnabled
          ? directValue
          : (actionableRows[0]?.value ?? '')
  return (
    <Command
      label={translate('workspace.links.searchLabel', 'Search references')}
      value={commandValue}
      onValueChange={setSelection}
      shouldFilter={false}
      surface="inline"
      className="min-h-0"
    >
      <div className="shrink-0 space-y-2">
        <label htmlFor={inputId} className="text-xs font-medium">
          {translate('workspace.links.addReference', 'Add reference')}
        </label>
        <SmartWorkspaceSourceTabs
          model={controller}
          inputRef={props.inputRef}
          onModeChange={(mode) => {
            controller.setMode(mode)
            changeMode(mode)
            requestAnimationFrame(() => props.inputRef.current?.focus({ preventScroll: true }))
          }}
        />
        <CommandInput
          ref={props.inputRef}
          id={inputId}
          value={query}
          placeholder={translate(
            'workspace.links.searchReferences',
            'Search reviews and tasks, or paste a link'
          )}
          variant="framed"
          disabled={props.disabled}
          trailing={
            <div className="flex items-center gap-1">
              {controller.showSearchSpinner ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : null}
              {query ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate('workspace.links.clearSearch', 'Clear search')}
                  onClick={() => {
                    onQueryChange('')
                    setSelection('')
                    props.inputRef.current?.focus()
                  }}
                >
                  <X />
                </Button>
              ) : null}
            </div>
          }
          aria-invalid={Boolean(scopeError || props.error) || undefined}
          onValueChange={(value) => {
            onQueryChange(value)
            setSelection('')
          }}
          onCompositionStart={(event) => {
            event.currentTarget.dataset.imeComposing = 'true'
          }}
          onCompositionEnd={(event) => {
            delete event.currentTarget.dataset.imeComposing
          }}
          onBlur={(event) => {
            delete event.currentTarget.dataset.imeComposing
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault()
              event.stopPropagation()
              onQueryChange('')
              setSelection('')
              return
            }
            if (isScreenSubmitShortcut(event)) {
              event.preventDefault()
              event.stopPropagation()
              props.onSave()
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              if (!query.trim()) {
                return
              }
              if (commandValue === directValue && direct && directEnabled) {
                add(direct)
              } else {
                const selected = actionableRows.find((row) => row.value === commandValue)
                if (selected) {
                  selectRow(selected)
                }
              }
            }
          }}
        />
      </div>
      {query.trim() ? (
        <div className="mt-2 flex max-h-60 min-h-0 shrink flex-col overflow-hidden">
          <SmartWorkspaceSourceResultList
            model={controller}
            onSelect={selectRow}
            isLinked={linked}
            isRowDisabled={() => props.disabled || controller.isQueryStale}
            emptyHint={translate(
              'workspace.links.noReferences',
              'No matching references. Try a title, number, or URL.'
            )}
            beforeResults={
              direct ? (
                <div className="border-b border-border p-1">
                  <CommandItem
                    value={directValue}
                    selection="palette"
                    disabled={!directEnabled}
                    onSelect={() => add(direct)}
                  >
                    <Plus className="size-3.5" />
                    <span>
                      {translate('workspace.links.addItem', 'Add {{label}}', {
                        label: workspaceAttachmentLabel(direct)
                      })}
                    </span>
                    {directLinked ? (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {translate('workspace.links.linkedResult', 'Linked')}
                      </span>
                    ) : null}
                  </CommandItem>
                </div>
              ) : null
            }
          />
        </div>
      ) : null}
      {query.trim() ? (
        <div className="mt-2 flex shrink-0 items-center justify-between gap-3">
          <WorkspaceAttachmentSourceStatus
            controller={controller}
            taskUrlProvider={taskUrlProvider}
            resolved={Boolean(resolvedDirectRow)}
            error={props.error ?? scopeError}
            onRetry={onRetry}
          />
          {/^[#!]?\d+$|^[a-z][a-z0-9]*-\d+$/i.test(query.trim()) ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="xs">
                  <ChevronDown className="size-3" />
                  {translate('workspace.links.referenceType', 'Reference type')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={kind}
                  onValueChange={(value) => {
                    if (isAttachmentInputKind(value)) {
                      controller.setMode('smart')
                      onKindChange(value)
                    }
                  }}
                >
                  {ATTACHMENT_INPUT_KINDS.map((option) => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label()}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
    </Command>
  )
}
