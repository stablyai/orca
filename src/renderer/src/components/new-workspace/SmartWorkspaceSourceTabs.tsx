import React from 'react'
import { ListTodo } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'
import type { SmartWorkspaceNameModeOption } from './smart-workspace-localized-options'
import type { WorkItemSourceSearch } from './use-work-item-source-search'

/** Task sources share one "Tasks" tab; a switcher inside it picks the source. */
export const TASK_SOURCE_MODES: readonly SmartNameMode[] = ['github', 'linear', 'jira', 'gitlab']
const TASKS_TAB = 'tasks'
const LAST_TASK_SOURCE_KEY = 'orca.newWorkspace.lastTaskSource'

function isTaskSourceMode(mode: SmartNameMode): boolean {
  return TASK_SOURCE_MODES.includes(mode)
}

function readLastTaskSource(): SmartNameMode | null {
  try {
    const value = window.localStorage.getItem(LAST_TASK_SOURCE_KEY)
    return TASK_SOURCE_MODES.find((mode) => mode === value) ?? null
  } catch {
    return null
  }
}

function rememberTaskSource(mode: SmartNameMode): void {
  try {
    window.localStorage.setItem(LAST_TASK_SOURCE_KEY, mode)
  } catch {
    // Storage can be unavailable (private window, quota); remembering is only a convenience.
  }
}

type TopTab = { id: string; label: string; Icon: SmartWorkspaceNameModeOption['Icon'] }

export function SmartWorkspaceSourceTabs({
  model,
  onModeChange,
  inputRef,
  tabsListRef
}: {
  model: Pick<WorkItemSourceSearch, 'mode' | 'availableModes'>
  onModeChange: (mode: WorkItemSourceSearch['mode']) => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  tabsListRef?: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  const taskSources = TASK_SOURCE_MODES.map((id) =>
    model.availableModes.find((item) => item.id === id)
  ).filter((item): item is SmartWorkspaceNameModeOption => item !== undefined)
  const topTabs: TopTab[] = []
  for (const item of model.availableModes) {
    if (isTaskSourceMode(item.id)) {
      if (!topTabs.some((tab) => tab.id === TASKS_TAB)) {
        topTabs.push({
          id: TASKS_TAB,
          label: t('components.newWorkspace.sourceTabs.tasks', 'Tasks'),
          Icon: ListTodo
        })
      }
      continue
    }
    topTabs.push(item)
  }
  const inTasks = isTaskSourceMode(model.mode)
  const selectTasks = (): void => {
    const last = readLastTaskSource()
    const next = taskSources.find((item) => item.id === last) ?? taskSources[0]
    if (next) {
      onModeChange(next.id)
    }
  }
  const selectTaskSource = (mode: SmartNameMode): void => {
    rememberTaskSource(mode)
    onModeChange(mode)
  }

  return (
    <div className="min-w-0 space-y-1.5">
      {/* Why: the wrapper scrolls; TabsList and TabsTrigger own their own spacing and type. */}
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b border-border/40 scrollbar-sleek">
        <Tabs
          value={inTasks ? TASKS_TAB : model.mode}
          onValueChange={(value) => {
            if (value === TASKS_TAB) {
              selectTasks()
              return
            }
            const mode = model.availableModes.find((item) => item.id === value)?.id
            if (mode) {
              onModeChange(mode)
            }
          }}
          className="min-w-0 flex-1 gap-0"
        >
          <TabsList
            ref={tabsListRef}
            variant="line"
            size="sm"
            className="justify-start"
            onFocusCapture={(event) => {
              const previous =
                event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
              const list = event.currentTarget
              if (previous && previous !== inputRef?.current && !list.contains(previous)) {
                event.stopPropagation()
                inputRef?.current?.focus({ preventScroll: true })
              }
            }}
          >
            {topTabs.map(({ id, label, Icon }) => (
              <Tooltip key={id}>
                {/* Why: TabsTrigger outermost so its data-state (active) wins over the tooltip's. */}
                <TabsTrigger
                  asChild
                  value={id}
                  tabIndex={-1}
                  // Why: icon-only tabs; the label lives in the tooltip and the accessible name.
                  aria-label={label}
                  data-smart-name-mode={id}
                  className="flex-none"
                >
                  <TooltipTrigger>
                    <Icon className="size-3.5" />
                  </TooltipTrigger>
                </TabsTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {label}
                </TooltipContent>
              </Tooltip>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {inTasks && taskSources.length > 1 ? (
        <div
          role="radiogroup"
          aria-label={t('components.newWorkspace.sourceTabs.taskSource', 'Task source')}
          className="flex min-w-0 flex-wrap items-center gap-1"
        >
          {taskSources.map(({ id, label, Icon }) => {
            const active = id === model.mode
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                data-task-source={id}
                onClick={() => selectTaskSource(id)}
                className={cn(
                  'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-border bg-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                )}
              >
                <Icon className="size-3" />
                {label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
