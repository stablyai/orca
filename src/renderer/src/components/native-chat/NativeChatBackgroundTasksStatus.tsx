import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

function backgroundTaskLabel(task: AgentSessionBackgroundTask): string {
  if (task.description) {
    return task.description
  }
  switch (task.kind) {
    case 'agent':
      return translate('components.native-chat.backgroundTasks.agent', 'Background agent')
    case 'workflow':
      return translate('components.native-chat.backgroundTasks.workflow', 'Background workflow')
    case 'command':
      return translate('components.native-chat.backgroundTasks.command', 'Background command')
    case 'monitor':
      return translate('components.native-chat.backgroundTasks.monitor', 'Background monitor')
    case 'unknown':
      return translate('components.native-chat.backgroundTasks.task', 'Background task')
  }
}

export function NativeChatBackgroundTasksStatus(props: {
  tasks: readonly AgentSessionBackgroundTask[]
  supportsTaskStop: boolean
  stoppingTaskIds: ReadonlySet<string>
  stoppingAll: boolean
  onStop: (taskId?: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const taskListId = useId()
  return (
    <div
      data-native-chat-background-tasks="true"
      className="shrink-0 bg-background px-3 pt-2 sm:px-4"
    >
      <div className="mx-auto w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-muted/50 text-xs text-muted-foreground shadow-xs">
        <div className="flex h-8 items-center px-1.5">
          <button
            type="button"
            className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-expanded={expanded}
            aria-controls={taskListId}
            onClick={() => setExpanded((current) => !current)}
          >
            <span aria-hidden="true">
              <AgentStateDot state="monitoring" size="md" title={null} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {translate(
                'components.native-chat.backgroundTasks.monitoring',
                'Monitoring background tasks'
              )}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        </div>
        {expanded ? (
          <div
            id={taskListId}
            className="scrollbar-sleek max-h-40 overflow-y-auto border-t border-border px-3 py-2"
          >
            {props.tasks.length > 0 ? (
              <ul
                role="list"
                aria-label={translate(
                  'components.native-chat.backgroundTasks.runningList',
                  'Running background tasks'
                )}
                className="space-y-1.5"
              >
                {props.tasks.map((task) => {
                  const label = backgroundTaskLabel(task)
                  return (
                    <li
                      key={task.id}
                      className="flex min-w-0 items-center gap-2 text-foreground/80"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-primary"
                      />
                      <span className="min-w-0 flex-1 break-words">{label}</span>
                      {props.supportsTaskStop ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label={translate(
                            'components.native-chat.backgroundTasks.stopTask',
                            'Stop {{value0}}',
                            { value0: label }
                          )}
                          disabled={props.stoppingTaskIds.has(task.id)}
                          onClick={() => props.onStop(task.id)}
                        >
                          {translate('components.native-chat.backgroundTasks.stop', 'Stop')}
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p>
                {translate(
                  'components.native-chat.backgroundTasks.detailsUnavailable',
                  'Task details are unavailable for this session.'
                )}
              </p>
            )}
            {!props.supportsTaskStop ? (
              <div className={props.tasks.length > 0 ? 'mt-2 border-t border-border pt-2' : 'mt-2'}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={translate(
                    'components.native-chat.backgroundTasks.stopAll',
                    'Stop background tasks'
                  )}
                  disabled={props.stoppingAll}
                  onClick={() => props.onStop()}
                >
                  {translate('components.native-chat.backgroundTasks.stop', 'Stop')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
