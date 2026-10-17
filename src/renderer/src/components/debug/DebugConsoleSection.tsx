import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ImeInput } from '@/lib/ime-text-field'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { debugErrorMessage, type DebugSectionProps } from './debug-section-contract'
import {
  buildConsoleView,
  DEBUG_CONSOLE_VIEW_CAP,
  EMPTY_CONSOLE_HISTORY,
  pushConsoleHistory,
  stepConsoleHistory,
  type DebugConsoleLocalCategory,
  type DebugConsoleLocalLine
} from './debug-console-model'

const TAIL_SLACK_PX = 4

export default function DebugConsoleSection({
  client,
  target,
  session
}: DebugSectionProps): React.JSX.Element {
  const [local, setLocal] = useState<DebugConsoleLocalLine[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState(EMPTY_CONSOLE_HISTORY)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followTail = useRef(true)
  const order = useRef(0)
  const lines = useMemo(() => buildConsoleView(session.console, local), [session.console, local])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && followTail.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [lines])

  const addLocal = (category: DebugConsoleLocalCategory, text: string): void => {
    const afterSeq = session.console.at(-1)?.seq ?? 0
    order.current += 1
    const line = { afterSeq, order: order.current, category, text }
    setLocal((previous) => [...previous, line].slice(-DEBUG_CONSOLE_VIEW_CAP))
  }

  const submit = async (): Promise<void> => {
    const expression = input.trim()
    if (!expression) {
      return
    }
    setInput('')
    setHistory((previous) => pushConsoleHistory(previous, expression))
    addLocal('input', `> ${expression}`)
    let outcome: { category: DebugConsoleLocalCategory; text: string }
    try {
      const result = await client.evaluate({
        ...target,
        expression,
        context: 'repl',
        ...(session.selectedFrameId === null ? {} : { frameId: session.selectedFrameId })
      })
      outcome = result.ok
        ? { category: 'result', text: result.value.result }
        : { category: 'error', text: result.message }
    } catch (caught) {
      outcome = { category: 'error', text: debugErrorMessage(caught) }
    }
    followTail.current = true
    addLocal(outcome.category, outcome.text)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const step = stepConsoleHistory(history, event.key === 'ArrowUp' ? -1 : 1, input)
      setHistory(step.history)
      setInput(step.value)
    }
  }

  return (
    <div className="flex flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-label={translate('debug.console.title', 'Debug Console')}
        className="scrollbar-sleek max-h-64 min-h-12 overflow-y-auto px-2 py-1 font-mono"
        onScroll={(event) => {
          const element = event.currentTarget
          followTail.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= TAIL_SLACK_PX
        }}
      >
        {lines.map((line) => (
          <div
            key={line.id}
            data-category={line.category}
            className={cn(
              'whitespace-pre-wrap break-all',
              (line.category === 'stderr' || line.category === 'error') && 'text-destructive',
              (line.category === 'console' || line.category === 'input') && 'text-muted-foreground'
            )}
          >
            {line.text}
          </div>
        ))}
      </div>
      <div className="px-2 py-1">
        <ImeInput
          aria-label={translate('debug.console.input', 'Evaluate expression')}
          placeholder={translate('debug.console.input', 'Evaluate expression')}
          className="w-full min-w-0 rounded-sm border border-input bg-transparent px-2 py-0.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
