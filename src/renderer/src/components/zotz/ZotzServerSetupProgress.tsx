import { ChevronDown, ChevronRight, TerminalSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ZotzNodeSetupStep } from '../../../../shared/zotz/zotz-node-setup-contract'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { Progress } from '../ui/progress'
import {
  zotzNodeSetupStepDetail,
  zotzNodeSetupStepHint,
  zotzNodeSetupStepTitle
} from './zotz-node-setup-step-labels'

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Seconds since the current step started, ticking only while one runs. */
function useStepElapsed(runningId: string | null): number {
  const [started, setStarted] = useState<{ id: string; at: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!runningId) {
      return
    }
    const at = Date.now()
    setStarted({ id: runningId, at })
    setNow(at)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runningId])
  return runningId && started?.id === runningId ? now - started.at : 0
}

/** "Step 3 of 9" header, what the running step is doing, and the raw setup output. */
export function ZotzServerSetupProgress({
  steps,
  output,
  finished,
  failed
}: {
  steps: ZotzNodeSetupStep[]
  output: string[]
  finished: boolean
  failed: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const running = steps.find((step) => step.status === 'running') ?? null
  const elapsed = useStepElapsed(running?.id ?? null)
  const settled = steps.filter(
    (step) => step.status !== 'pending' && step.status !== 'running'
  ).length
  const position = running ? steps.indexOf(running) + 1 : settled
  const percent = steps.length === 0 ? 0 : Math.round((settled / steps.length) * 100)
  const detail = running ? zotzNodeSetupStepDetail(running, t) : null
  const hint = running ? zotzNodeSetupStepHint(running.id, t) : null

  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card/50 p-4 shadow-xs"
      aria-live="polite"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-sm font-semibold">
          {finished
            ? failed
              ? t('zotz.nodeSetup.progress.finishedWithErrors', 'Finished with errors')
              : t('zotz.nodeSetup.progress.finished', 'Setup finished')
            : running
              ? t('zotz.nodeSetup.progress.step', 'Step {{current}} of {{total}}: {{title}}', {
                  current: position,
                  total: steps.length,
                  title: zotzNodeSetupStepTitle(running.id, t)
                })
              : t('zotz.nodeSetup.progress.preparing', 'Preparing…')}
        </p>
        {running ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        ) : null}
      </div>
      <Progress value={finished ? 100 : percent} className="h-1.5" />
      {running && (detail || hint) ? (
        <div className="space-y-1">
          {detail ? <p className="text-sm">{detail}</p> : null}
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      ) : null}
      <SetupConsole output={output} />
    </section>
  )
}

function SetupConsole({ output }: { output: string[] }): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(true)
  const scrollRef = useRef<HTMLPreElement>(null)
  const lineCount = output.length
  useEffect(() => {
    const element = scrollRef.current
    if (element && open) {
      element.scrollTop = element.scrollHeight
    }
  }, [lineCount, open])
  if (lineCount === 0) {
    return null
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <TerminalSquare className="size-3.5" />
        {t('zotz.nodeSetup.progress.output', 'Setup output')}
      </button>
      {open ? (
        <pre
          ref={scrollRef}
          className={cn(
            'scrollbar-sleek max-h-56 overflow-auto rounded-md border border-border bg-muted/50 p-3',
            'font-mono text-xs leading-relaxed whitespace-pre-wrap break-words'
          )}
        >
          {output.map((line, index) => (
            <div
              key={index}
              className={cn(
                line.startsWith('== ') && 'font-semibold',
                / -> failed/.test(line) && 'text-destructive',
                / -> (done|skipped)/.test(line) && 'text-muted-foreground'
              )}
            >
              {line}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  )
}
