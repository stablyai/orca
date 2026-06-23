import { useEffect, useState, type JSX } from 'react'
import { AgentsOrchestrationVisual } from '@/components/feature-wall/AgentsOrchestrationVisual'
import {
  ORCHESTRATION_CLI_COMMAND_LOOP_MS,
  ORCHESTRATION_CLI_COMMAND_TIMINGS_MS
} from '@/components/feature-wall/agents-orchestration/orchestration-types'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { translate } from '@/i18n/i18n'

const CLI_AGENT_COMMANDS = [
  'orca worktree create --name auth-pr-1',
  'orca worktree create --name auth-pr-2',
  'orca orchestration dispatch --task pr1 --to w1',
  'orca orchestration dispatch --task pr2 --to w2'
]

export function CliFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [animatedVisibleCommandCount, setAnimatedVisibleCommandCount] = useState(0)
  // Why: reduced-motion users should see the static completed state without a
  // post-render state repair; only the animated path needs timer-backed state.
  const visibleCommandCount = reducedMotion
    ? CLI_AGENT_COMMANDS.length
    : animatedVisibleCommandCount

  useEffect(() => {
    if (reducedMotion) {
      return
    }

    let cancelled = false
    const timeouts: number[] = []
    const later = (fn: () => void, ms: number): void => {
      timeouts.push(window.setTimeout(() => !cancelled && fn(), ms))
    }

    // Why: terminal lines mirror the orchestration tour beat timings so the
    // shell shows each command as the parent agent runs it.
    const runOnce = (): void => {
      setAnimatedVisibleCommandCount(0)
      ORCHESTRATION_CLI_COMMAND_TIMINGS_MS.forEach((ms, index) => {
        later(() => setAnimatedVisibleCommandCount(index + 1), ms)
      })
      later(runOnce, ORCHESTRATION_CLI_COMMAND_LOOP_MS)
    }

    runOnce()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [reducedMotion])

  return (
    <div
      className="relative flex min-h-[27rem] flex-col overflow-hidden bg-muted/60 px-6 py-7"
      aria-hidden="true"
    >
      <div className="relative rounded-lg border border-border/70 bg-card/95 shadow-xs">
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <span className="size-2 rounded-full bg-muted-foreground/35" />
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="size-2 rounded-full bg-muted-foreground/20" />
        </div>
        <div className="space-y-1.5 px-3 py-3 font-mono text-[10.5px] leading-[1.35] text-foreground">
          <div className="truncate text-muted-foreground">
            <span className="mr-1.5 text-foreground">●</span>
            {translate(
              'auto.components.feature.tips.CliFeatureTipVisual.22e62f3bab',
              'Claude Code session started'
            )}
          </div>
          {CLI_AGENT_COMMANDS.map((command, index) => {
            const isVisible = index < visibleCommandCount
            const isCurrentLine = isVisible && index === visibleCommandCount - 1
            return (
              <div
                key={command}
                className={`truncate ${isVisible ? 'animate-cli-tip-command-line' : 'invisible'}`}
              >
                <span className="text-foreground">
                  {translate('auto.components.feature.tips.CliFeatureTipVisual.badb4fc342', '>')}
                </span>
                <span>{command}</span>
                {isCurrentLine ? (
                  <span className="animate-cli-tip-caret ml-0.5 inline-block h-3 w-1 translate-y-0.5 rounded-sm bg-foreground/70" />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      <div className="cli-tip-orchestration-frame relative mt-5 flex h-[17rem] items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-background/80 px-5 shadow-xs">
        <div className="origin-center">
          <AgentsOrchestrationVisual
            activeStepId="orchestration"
            reducedMotion={reducedMotion}
            widthPx={350}
            heightPx={252}
            orchestrationCreatedChildCount={Math.min(visibleCommandCount, 2)}
            orchestrationLoopMs={ORCHESTRATION_CLI_COMMAND_LOOP_MS}
            orchestrationShowResponseBeats={false}
          />
        </div>
      </div>
    </div>
  )
}
