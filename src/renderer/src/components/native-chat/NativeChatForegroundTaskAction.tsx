import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  agentSessionForegroundTaskKey,
  type AgentSessionForegroundTask,
  type AgentSessionBackgroundResult
} from '../../../../shared/agent-session/agent-session-foreground-task'

type Actions = {
  tasks: readonly AgentSessionForegroundTask[]
  pending: ReadonlySet<string>
  run: (task: AgentSessionForegroundTask) => void
}
const Context = createContext<Actions | null>(null)

export function NativeChatForegroundTasksProvider(props: {
  tasks?: readonly AgentSessionForegroundTask[]
  backgroundTask: (task: AgentSessionForegroundTask) => Promise<AgentSessionBackgroundResult | null>
  children: ReactNode
}) {
  const inFlight = useRef(new Set<string>())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const { backgroundTask, tasks } = props
  const run = useCallback(
    (task: AgentSessionForegroundTask) => {
      const key = agentSessionForegroundTaskKey(task)
      if (inFlight.current.has(key)) {
        return
      }
      inFlight.current.add(key)
      setPending(new Set(inFlight.current))
      void backgroundTask(task)
        .then((result) => {
          if (!result?.backgrounded) {
            inFlight.current.delete(key)
          }
        })
        .catch(() => inFlight.current.delete(key))
        .finally(() => setPending(new Set(inFlight.current)))
    },
    [backgroundTask]
  )
  const value = useMemo(() => ({ tasks: tasks ?? [], pending, run }), [tasks, pending, run])
  return <Context value={value}>{props.children}</Context>
}

/** Both transcript calls and task rows name the same host-captured invocation. */
export function NativeChatForegroundTaskAction(props: { toolUseId?: string; taskId?: string }) {
  const actions = useContext(Context)
  const task = actions?.tasks.find(
    (candidate) =>
      (props.toolUseId !== undefined && candidate.toolUseId === props.toolUseId) ||
      (props.taskId !== undefined && candidate.taskId === props.taskId)
  )
  if (!actions || !task) {
    return null
  }
  const pending = actions.pending.has(agentSessionForegroundTaskKey(task))
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={pending}
      onClick={() => actions.run(task)}
    >
      {pending
        ? translate('components.native-chat.backgroundTasks.backgrounding', 'Backgrounding…')
        : translate('components.native-chat.backgroundTasks.background', 'Background')}
    </Button>
  )
}
