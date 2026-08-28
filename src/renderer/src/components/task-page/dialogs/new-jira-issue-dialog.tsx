import React from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { getJiraProjectPickerDisplayLabel as getJiraProjectDisplayLabel } from '@/components/jira-project-picker-filter'
import { NewJiraIssueCustomFields } from './new-jira-issue-custom-fields'
import { getJiraProjectSelectionKey } from '@/components/task-page-jira-project-selection'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { JiraCreateField, JiraIssueType, JiraProject } from '../../../../../shared/jira-types'

export type NewJiraIssueDialogProps = {
  newJiraIssueOpen: boolean
  newJiraIssueSubmitting: boolean
  setNewJiraIssueOpen: (open: boolean) => void
  handleCreateNewJiraIssue: () => Promise<void> | void
  newJiraIssueTargetProject: JiraProject | null
  includeJiraSiteNameInProjectLabel: boolean
  newJiraIssueProjectCommandValue: string
  setNewJiraIssueProjectCommandValue: (value: string) => void
  newJiraIssueProjectSearchInputRef: React.RefObject<HTMLInputElement | null>
  newJiraIssueProjectQuery: string
  setNewJiraIssueProjectQuery: (value: string) => void
  filteredNewJiraIssueProjects: JiraProject[]
  sortedAvailableJiraProjects: JiraProject[]
  newJiraIssueTargetProjectSelectionKey: string | null
  handleNewJiraIssueProjectSelect: (selectionKey: string) => void
  handleNewJiraIssueProjectComboboxOpenChange: (open: boolean) => void
  handleNewJiraIssueProjectTriggerKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  newJiraIssueProjectComboboxOpen: boolean
  newJiraIssueTypeId: string | null
  newJiraIssueTargetType: JiraIssueType | null
  setNewJiraIssueTypeId: (id: string | null) => void
  jiraIssueTypesLoading: boolean
  availableJiraIssueTypes: JiraIssueType[]
  newJiraIssueTitle: string
  setNewJiraIssueTitle: (value: string) => void
  newJiraIssueBody: string
  setNewJiraIssueBody: (value: string) => void
  jiraCreateFieldsLoading: boolean
  jiraCreateFieldsError: string | null
  visibleJiraCreateFields: JiraCreateField[]
  newJiraIssueCustomFieldValues: Record<string, string>
  setNewJiraIssueCustomFieldValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  hasMissingJiraCreateField: boolean
  submitShortcutLabel: string
}

export function NewJiraIssueDialog(props: NewJiraIssueDialogProps): React.JSX.Element {
  const {
    newJiraIssueOpen,
    newJiraIssueSubmitting,
    setNewJiraIssueOpen,
    handleCreateNewJiraIssue,
    newJiraIssueTargetProject,
    includeJiraSiteNameInProjectLabel,
    newJiraIssueProjectCommandValue,
    setNewJiraIssueProjectCommandValue,
    newJiraIssueProjectSearchInputRef,
    newJiraIssueProjectQuery,
    setNewJiraIssueProjectQuery,
    filteredNewJiraIssueProjects,
    sortedAvailableJiraProjects,
    newJiraIssueTargetProjectSelectionKey,
    handleNewJiraIssueProjectSelect,
    handleNewJiraIssueProjectComboboxOpenChange,
    handleNewJiraIssueProjectTriggerKeyDown,
    newJiraIssueProjectComboboxOpen,
    newJiraIssueTypeId,
    newJiraIssueTargetType,
    setNewJiraIssueTypeId,
    jiraIssueTypesLoading,
    availableJiraIssueTypes,
    newJiraIssueTitle,
    setNewJiraIssueTitle,
    newJiraIssueBody,
    setNewJiraIssueBody,
    jiraCreateFieldsLoading,
    jiraCreateFieldsError,
    visibleJiraCreateFields,
    newJiraIssueCustomFieldValues,
    setNewJiraIssueCustomFieldValues,
    hasMissingJiraCreateField,
    submitShortcutLabel
  } = props
  return (
    <Dialog
      open={newJiraIssueOpen}
      onOpenChange={(open) => {
        if (!newJiraIssueSubmitting) {
          setNewJiraIssueOpen(open)
        }
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event)) {
            event.preventDefault()
            void handleCreateNewJiraIssue()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.TaskPage.0c11ca0b6d', 'New Jira issue')}
          </DialogTitle>
          <DialogDescription>
            {newJiraIssueTargetProject
              ? translate(
                  'auto.components.TaskPage.0f7b0d964a',
                  'Creates a new issue in {{value0}}.',
                  { value0: newJiraIssueTargetProject.key }
                )
              : translate(
                  'auto.components.TaskPage.e178c0a953',
                  'Choose a Jira project before creating the issue.'
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {translate('auto.components.TaskPage.00022ec0ba', 'Project')}
              </label>
              <Popover
                open={newJiraIssueProjectComboboxOpen}
                onOpenChange={handleNewJiraIssueProjectComboboxOpenChange}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={newJiraIssueProjectComboboxOpen}
                    onKeyDown={handleNewJiraIssueProjectTriggerKeyDown}
                    disabled={newJiraIssueSubmitting || sortedAvailableJiraProjects.length === 0}
                    className="h-9 w-full justify-between px-3 text-left text-xs font-normal"
                  >
                    {newJiraIssueTargetProject ? (
                      <span className="min-w-0 truncate">
                        {getJiraProjectDisplayLabel(
                          newJiraIssueTargetProject,
                          includeJiraSiteNameInProjectLabel
                        )}
                      </span>
                    ) : (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {translate('auto.components.TaskPage.00022ec0ba', 'Project')}
                      </span>
                    )}
                    <ChevronDown className="size-3.5 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
                  onOpenAutoFocus={(event) => event.preventDefault()}
                >
                  <Command
                    shouldFilter={false}
                    value={newJiraIssueProjectCommandValue}
                    onValueChange={setNewJiraIssueProjectCommandValue}
                  >
                    <CommandInput
                      ref={newJiraIssueProjectSearchInputRef}
                      placeholder={translate(
                        'auto.components.TaskPage.cfb56a7868',
                        'Search projects...'
                      )}
                      value={newJiraIssueProjectQuery}
                      onValueChange={setNewJiraIssueProjectQuery}
                    />
                    <CommandList className="max-h-56">
                      <CommandEmpty>
                        {translate('auto.components.TaskPage.93c57f15e5', 'No projects found.')}
                      </CommandEmpty>
                      {filteredNewJiraIssueProjects.map((project) => {
                        const selectionKey = getJiraProjectSelectionKey(project)
                        const selected = selectionKey === newJiraIssueTargetProjectSelectionKey
                        return (
                          <CommandItem
                            key={selectionKey}
                            value={selectionKey}
                            onSelect={() => handleNewJiraIssueProjectSelect(selectionKey)}
                            className="items-center gap-2 px-3 py-2 text-xs"
                          >
                            <Check
                              className={cn(
                                'size-3.5 text-foreground',
                                selected ? 'opacity-100' : 'opacity-0'
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {getJiraProjectDisplayLabel(
                                project,
                                includeJiraSiteNameInProjectLabel
                              )}
                            </span>
                          </CommandItem>
                        )
                      })}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {translate('auto.components.TaskPage.ae592fee62', 'Issue type')}
              </label>
              <Select
                value={newJiraIssueTypeId ?? newJiraIssueTargetType?.id ?? undefined}
                onValueChange={(v) => setNewJiraIssueTypeId(v)}
                disabled={
                  newJiraIssueSubmitting ||
                  jiraIssueTypesLoading ||
                  availableJiraIssueTypes.length === 0
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      jiraIssueTypesLoading
                        ? translate('auto.components.TaskPage.7d63e2626e', 'Loading...')
                        : translate('auto.components.TaskPage.ae592fee62', 'Issue type')
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableJiraIssueTypes.map((issueType) => (
                    <SelectItem key={issueType.id} value={issueType.id}>
                      {issueType.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.16cba35bee', 'Title')}
            </label>
            <Input
              autoFocus
              value={newJiraIssueTitle}
              onChange={(e) => setNewJiraIssueTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleCreateNewJiraIssue()
                }
              }}
              placeholder={translate('auto.components.TaskPage.578f730c16', 'Short summary')}
              disabled={newJiraIssueSubmitting}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.f161bf9ede', 'Description (optional)')}
            </label>
            <Textarea
              value={newJiraIssueBody}
              onChange={(e) => setNewJiraIssueBody(e.target.value)}
              placeholder={translate('auto.components.TaskPage.34d97ca682', "What's going on?")}
              rows={6}
              disabled={newJiraIssueSubmitting}
              className="max-h-60 resize-none overflow-y-auto scrollbar-sleek text-sm"
            />
          </div>
          {jiraCreateFieldsLoading ? (
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              {translate('auto.components.TaskPage.cbcdcbe244', 'Loading required Jira fields…')}
            </div>
          ) : null}
          {jiraCreateFieldsError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {jiraCreateFieldsError}
            </p>
          ) : null}
          <NewJiraIssueCustomFields
            visibleJiraCreateFields={visibleJiraCreateFields}
            newJiraIssueCustomFieldValues={newJiraIssueCustomFieldValues}
            setNewJiraIssueCustomFieldValues={setNewJiraIssueCustomFieldValues}
            newJiraIssueSubmitting={newJiraIssueSubmitting}
          />
          <p className="text-[10px] text-muted-foreground">
            {submitShortcutLabel} {translate('auto.components.TaskPage.fc0d8a1fa4', 'to submit.')}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setNewJiraIssueOpen(false)}
            disabled={newJiraIssueSubmitting}
          >
            {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleCreateNewJiraIssue()}
            disabled={
              !newJiraIssueTargetProject ||
              !newJiraIssueTargetType ||
              !newJiraIssueTitle.trim() ||
              hasMissingJiraCreateField ||
              jiraCreateFieldsLoading ||
              newJiraIssueSubmitting
            }
          >
            {newJiraIssueSubmitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {translate('auto.components.TaskPage.8ff6fdc368', 'Creating…')}
              </>
            ) : (
              translate('auto.components.TaskPage.e15ba2d2eb', 'Create issue')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
