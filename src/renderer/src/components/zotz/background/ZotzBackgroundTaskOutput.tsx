import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentChildRowModel } from '../../../../../shared/agent-status/presentation/agent-child-row-model'
import {
  useZotzBackgroundTaskOutputs,
  zotzTaskCallOutput,
  type ZotzBackgroundTaskOutputs
} from './zotz-background-task-outputs'
import { zotzOutputTail } from './zotz-background-task-output-read'

const REFRESH_MS = 1000

type OutputState = { kind: 'loading' } | { kind: 'loaded'; text: string } | { kind: 'failed' }

function useTaskOutputTail(
  outputs: ZotzBackgroundTaskOutputs,
  filePath: string,
  live: boolean
): OutputState {
  const [state, setState] = useState<OutputState>({ kind: 'loading' })
  useEffect(() => {
    const worktreeId = outputs.worktreeId
    if (!worktreeId) {
      setState({ kind: 'failed' })
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      void outputs.read(worktreeId, filePath).then(
        (text) => {
          if (!cancelled) {
            setState({ kind: 'loaded', text })
          }
        },
        () => {
          if (!cancelled) {
            setState((previous) => (previous.kind === 'loaded' ? previous : { kind: 'failed' }))
          }
        }
      )
      // Settled tasks write nothing more; read them once.
      if (live && !cancelled) {
        timer = setTimeout(tick, REFRESH_MS)
      }
    }
    tick()
    return () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [outputs, filePath, live])
  return state
}

function OutputText({ text }: { text: string }): React.JSX.Element {
  const t = useTranslate()
  const preRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    // Follow the newest lines, like a terminal.
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [text])
  return (
    <pre
      ref={preRef}
      className="scrollbar-sleek max-h-60 overflow-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-3xs leading-4 text-foreground"
    >
      {text || t('zotz.background.outputEmpty', 'No output yet')}
    </pre>
  )
}

function OutputTail({
  outputs,
  filePath,
  live
}: {
  outputs: ZotzBackgroundTaskOutputs
  filePath: string
  live: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const state = useTaskOutputTail(outputs, filePath, live)
  if (state.kind === 'loading') {
    return (
      <p className="px-2 py-1 text-muted-foreground">
        {t('zotz.background.outputLoading', 'Reading output…')}
      </p>
    )
  }
  if (state.kind === 'failed') {
    return (
      <p className="px-2 py-1 text-muted-foreground">
        {t('zotz.background.outputUnavailable', 'The output could not be read.')}
      </p>
    )
  }
  return <OutputText text={state.text} />
}

function TaskOutput({
  outputs,
  taskId,
  live
}: {
  outputs: ZotzBackgroundTaskOutputs
  taskId: string
  live: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const filePath = outputs.outputFiles.get(taskId)
  if (filePath) {
    return <OutputTail outputs={outputs} filePath={filePath} live={live} />
  }
  // Agents without an output file still stream the shell's output into the chat.
  const callOutput = zotzTaskCallOutput(outputs.callOutputs, taskId)
  if (callOutput !== null) {
    return <OutputText text={zotzOutputTail(callOutput, false)} />
  }
  return (
    <p className="px-2 py-1 text-muted-foreground">
      {t('zotz.background.outputNotShared', 'This agent does not share the output of its shells.')}
    </p>
  )
}

/** Background panel only: a shell row expands to its output; agent rows keep opening their chat. */
export function useZotzBackgroundTaskOutputToggle(row: AgentChildRowModel): {
  open: boolean
  toggle: () => void
  chevron: React.JSX.Element
  panel: React.JSX.Element | null
} | null {
  const outputs = useZotzBackgroundTaskOutputs()
  const [open, setOpen] = useState(false)
  if (!outputs || (row.kind !== 'command' && row.kind !== 'monitor')) {
    return null
  }
  const Chevron = open ? ChevronDown : ChevronRight
  return {
    open,
    toggle: () => setOpen((value) => !value),
    chevron: <Chevron aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />,
    panel: open ? (
      <li className="ml-5 overflow-hidden rounded-md border border-border bg-background text-xs">
        <TaskOutput outputs={outputs} taskId={row.providerId ?? row.id} live={!row.settled} />
      </li>
    ) : null
  }
}
