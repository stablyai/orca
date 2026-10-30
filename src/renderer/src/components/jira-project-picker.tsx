import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { JiraProject } from '../../../shared/jira/jira-types'
import {
  normalizeJiraProjectReference,
  matchesJiraProject,
  type JiraProjectReference
} from '../../../shared/jira/jira-project-reference'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from './ui/command'
import { getJiraProjectSelectionKey } from './task-page/jira/task-page-jira-project-selection'
import { translate } from '@/i18n/i18n'

export function JiraProjectPicker({
  projects,
  value,
  onChange,
  label,
  emptyLabel,
  disabled
}: {
  projects: readonly JiraProject[]
  value: JiraProjectReference | null
  onChange: (project: JiraProjectReference | null) => void
  label: string
  emptyLabel: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const select = (project: JiraProjectReference | null) => {
    onChange(project)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between"
        >
          <span className="truncate">{value ? `${value.key} · ${value.name}` : emptyLabel}</span>
          <ChevronsUpDown className="size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <Command>
          <CommandInput
            placeholder={translate('components.jiraProjectPicker.search', 'Search Jira projects')}
          />
          <CommandList>
            <CommandEmpty>
              {translate('components.jiraProjectPicker.empty', 'No projects found.')}
            </CommandEmpty>
            <CommandItem value={emptyLabel} onSelect={() => select(null)}>
              <span className="flex-1">{emptyLabel}</span>
              {!value ? <Check className="size-4" /> : null}
            </CommandItem>
            {projects.map((project) => {
              const reference = normalizeJiraProjectReference(project)
              return reference ? (
                <CommandItem
                  key={getJiraProjectSelectionKey(project)}
                  value={`${project.key} ${project.name} ${project.siteName ?? ''} ${project.siteId}`}
                  onSelect={() => select(reference)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {project.key} · {project.name}
                    </span>
                    {project.siteName ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {project.siteName}
                      </span>
                    ) : null}
                  </span>
                  {value && matchesJiraProject(project, value) ? (
                    <Check className="size-4" />
                  ) : null}
                </CommandItem>
              ) : null
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
