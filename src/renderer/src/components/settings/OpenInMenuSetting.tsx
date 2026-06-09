import type React from 'react'
import { useState } from 'react'
import { Check, ChevronDown, Pencil, Trash2 } from 'lucide-react'
import type { GlobalSettings, OpenInApplication } from '../../../../shared/types'
import { OPEN_IN_APPLICATIONS_MAX } from '../../../../shared/open-in-applications'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { cn } from '@/lib/utils'
import {
  getOpenInAppPreset,
  isOpenInAppPresetAdded,
  OpenInApplicationIcon,
  OPEN_IN_APP_PRESETS,
  type OpenInAppPreset
} from '@/lib/open-in-app-catalog'

type OpenInMenuSettingProps = {
  applications: OpenInApplication[] | undefined
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

type OpenInApplicationsDraftState = {
  sourceApplications: OpenInApplication[] | undefined
  draft: OpenInApplication[]
}

function createOpenInApplication(): OpenInApplication {
  return {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `open-in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    label: '',
    command: ''
  }
}

export function createPresetOpenInApplication(preset: OpenInAppPreset): OpenInApplication {
  return {
    id: preset.id,
    label: preset.label,
    command: preset.command
  }
}

function createOpenInApplicationsDraftState(
  openInApplications: OpenInApplication[] | undefined
): OpenInApplicationsDraftState {
  return {
    sourceApplications: openInApplications,
    draft: openInApplications ?? []
  }
}

function resolveOpenInApplicationsDraftState(
  state: OpenInApplicationsDraftState,
  openInApplications: OpenInApplication[] | undefined
): OpenInApplicationsDraftState {
  return state.sourceApplications === openInApplications
    ? state
    : createOpenInApplicationsDraftState(openInApplications)
}

export function shouldCommitOpenInApplicationsDraft(applications: OpenInApplication[]): boolean {
  return applications.every((application) => {
    return application.label.trim() !== '' && application.command.trim() !== ''
  })
}

function OpenInMenuRow({
  application,
  editing,
  onEditToggle,
  onRemove,
  onChange,
  onCommit
}: {
  application: OpenInApplication
  editing: boolean
  onEditToggle: () => void
  onRemove: () => void
  onChange: (updates: Pick<OpenInApplication, 'label' | 'command'>) => void
  onCommit: () => void
}): React.JSX.Element {
  const preset = getOpenInAppPreset(application)
  const isPreset =
    preset !== null &&
    (application.id === preset.id ||
      application.label.trim().toLowerCase() === preset.label.toLowerCase())

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          <OpenInApplicationIcon application={application} size={16} />
        </div>

        <div className="min-w-0 flex-1 sm:min-w-[12rem]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium leading-none">
              {application.label.trim() || 'New app'}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {application.command.trim() || 'Set command'}
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onEditToggle}
            title={editing ? 'Collapse app details' : 'Edit app'}
            aria-label={editing ? 'Collapse app details' : 'Edit app'}
            aria-expanded={editing}
            className={cn(
              'size-7 text-muted-foreground hover:text-foreground',
              editing && 'text-foreground'
            )}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            title="Remove app"
            aria-label="Remove app"
            className="size-7 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {editing && (
        <div
          className={cn(
            'mt-3 grid grid-cols-1 gap-2 pl-10',
            !isPreset && 'sm:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)]'
          )}
        >
          {!isPreset && (
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Menu label</Label>
              <Input
                value={application.label}
                placeholder="App name"
                onChange={(event) =>
                  onChange({ label: event.target.value, command: application.command })
                }
                onBlur={onCommit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onCommit()
                    event.currentTarget.blur()
                  }
                }}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Terminal command</Label>
            <Input
              value={application.command}
              placeholder="cursor"
              spellCheck={false}
              className="font-mono text-xs"
              onChange={(event) =>
                onChange({ label: application.label, command: event.target.value })
              }
              onBlur={onCommit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  onCommit()
                  event.currentTarget.blur()
                }
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              The command you would type in Terminal to open this app.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export function OpenInMenuSetting({
  applications,
  updateSettings
}: OpenInMenuSettingProps): React.JSX.Element {
  const [draftState, setDraftState] = useState(() =>
    createOpenInApplicationsDraftState(applications)
  )
  const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(new Set())

  const resolvedDraftState = resolveOpenInApplicationsDraftState(draftState, applications)
  if (resolvedDraftState !== draftState) {
    // Why: the Open menu rows are editable local drafts, but Settings can
    // reload from persistence while this pane is mounted.
    setDraftState(resolvedDraftState)
  }
  const draft = resolvedDraftState.draft
  const isAtLimit = draft.length >= OPEN_IN_APPLICATIONS_MAX

  const commit = (nextDraft: OpenInApplication[]): void => {
    if (!shouldCommitOpenInApplicationsDraft(nextDraft)) {
      return
    }
    updateSettings({ openInApplications: nextDraft })
  }

  const updateDraft = (nextDraft: OpenInApplication[]): void => {
    setDraftState((current) => ({
      ...resolveOpenInApplicationsDraftState(current, applications),
      draft: nextDraft
    }))
  }

  const applyDraft = (nextDraft: OpenInApplication[]): void => {
    updateDraft(nextDraft)
    commit(nextDraft)
  }

  const addPreset = (preset: OpenInAppPreset): void => {
    if (isAtLimit || isOpenInAppPresetAdded(draft, preset)) {
      return
    }
    applyDraft([...draft, createPresetOpenInApplication(preset)])
  }

  const addCustomApp = (): void => {
    if (isAtLimit) {
      return
    }
    const application = createOpenInApplication()
    updateDraft([...draft, application])
    setEditingIds((current) => new Set([...current, application.id]))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <Label>Open In Apps</Label>
          <p className="text-xs text-muted-foreground">
            Choose apps available from a workspace&apos;s Open in menu.
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isAtLimit}
              className="h-8 shrink-0 gap-1.5"
            >
              Add app
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {OPEN_IN_APP_PRESETS.map((preset) => {
              const isAdded = isOpenInAppPresetAdded(draft, preset)
              return (
                <DropdownMenuItem
                  key={preset.id}
                  disabled={isAdded || isAtLimit}
                  onSelect={() => addPreset(preset)}
                  className="gap-2"
                >
                  <OpenInApplicationIcon application={preset} size={14} />
                  <span className="min-w-0 truncate">{preset.label}</span>
                  {isAdded && (
                    <DropdownMenuShortcut className="inline-flex items-center gap-1">
                      <Check className="size-3" />
                      Added
                    </DropdownMenuShortcut>
                  )}
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuItem disabled={isAtLimit} onSelect={addCustomApp} className="gap-2">
              <OpenInApplicationIcon application={{ command: '' }} size={14} />
              <span className="min-w-0 truncate">Custom app</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {draft.length > 0 && (
        <div className="divide-y divide-border/40">
          {draft.map((application, index) => {
            const editing =
              editingIds.has(application.id) ||
              application.label.trim() === '' ||
              application.command.trim() === ''
            return (
              <OpenInMenuRow
                key={application.id}
                application={application}
                editing={editing}
                onEditToggle={() =>
                  setEditingIds((current) => {
                    const next = new Set(current)
                    if (next.has(application.id)) {
                      next.delete(application.id)
                    } else {
                      next.add(application.id)
                    }
                    return next
                  })
                }
                onRemove={() => {
                  const next = draft.filter((entry) => entry.id !== application.id)
                  applyDraft(next)
                  setEditingIds((current) => {
                    const nextEditing = new Set(current)
                    nextEditing.delete(application.id)
                    return nextEditing
                  })
                }}
                onChange={(updates) => {
                  const next = [...draft]
                  next[index] = { ...application, ...updates }
                  updateDraft(next)
                }}
                onCommit={() => commit(draft)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
