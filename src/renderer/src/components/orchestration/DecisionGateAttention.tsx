import { useState } from 'react'
import { CircleHelp, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { parseDecisionGateOptions } from './decision-gate-attention'
import { usePendingDecisionGates } from './usePendingDecisionGates'

export function DecisionGateAttention(): React.JSX.Element | null {
  const { gates, loading, error, resolve } = usePendingDecisionGates()
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [resolutionById, setResolutionById] = useState<Record<string, string>>({})
  const [resolveError, setResolveError] = useState<string | null>(null)

  if (!loading && gates.length === 0 && !error) {
    return null
  }

  const resolveGate = async (gateId: string, resolution: string): Promise<void> => {
    const trimmed = resolution.trim()
    if (!trimmed || resolvingId) {
      return
    }
    setResolvingId(gateId)
    setResolveError(null)
    try {
      await resolve(gateId, trimmed)
    } catch (resolveFailure) {
      setResolveError(
        resolveFailure instanceof Error
          ? resolveFailure.message
          : translate(
              'auto.components.orchestration.DecisionGateAttention.resolveFailed',
              'Unable to resolve decision'
            )
      )
    } finally {
      setResolvingId(null)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
            'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <CircleHelp className="size-4 shrink-0 text-worktree-sidebar-foreground/30" />
          <span className="flex-1">
            {translate('auto.components.orchestration.DecisionGateAttention.label', 'Decisions')}
          </span>
          {gates.length > 0 ? (
            <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
              {gates.length}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        className="popover-scroll-content scrollbar-sleek max-h-[min(32rem,80vh)] w-80 overflow-y-auto p-2"
      >
        <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate(
            'auto.components.orchestration.DecisionGateAttention.pending',
            'Pending decisions'
          )}
        </div>
        {loading && gates.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {translate(
              'auto.components.orchestration.DecisionGateAttention.loading',
              'Loading decisions…'
            )}
          </div>
        ) : null}
        {error ? <p className="px-2 py-2 text-xs text-destructive">{error}</p> : null}
        {resolveError ? <p className="px-2 py-2 text-xs text-destructive">{resolveError}</p> : null}
        <div className="space-y-2">
          {gates.map((gate) => {
            const options = parseDecisionGateOptions(gate.options)
            const resolving = resolvingId === gate.id
            return (
              <section key={gate.id} className="rounded-md border border-border bg-card p-3">
                <p className="break-words text-sm font-medium text-card-foreground">
                  {gate.question}
                </p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{gate.task_id}</p>
                {options.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {options.map((option, index) => (
                      <Button
                        key={`${gate.id}:${index}`}
                        type="button"
                        size="xs"
                        variant={index === 0 ? 'default' : 'secondary'}
                        disabled={resolvingId !== null}
                        onClick={() => void resolveGate(gate.id, option)}
                      >
                        {resolving && index === 0 ? <Loader2 className="animate-spin" /> : null}
                        {option}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void resolveGate(gate.id, resolutionById[gate.id] ?? '')
                    }}
                  >
                    <Input
                      value={resolutionById[gate.id] ?? ''}
                      onChange={(event) =>
                        setResolutionById((current) => ({
                          ...current,
                          [gate.id]: event.target.value
                        }))
                      }
                      placeholder={translate(
                        'auto.components.orchestration.DecisionGateAttention.answer',
                        'Enter a response'
                      )}
                      aria-label={translate(
                        'auto.components.orchestration.DecisionGateAttention.answer',
                        'Enter a response'
                      )}
                      disabled={resolvingId !== null}
                      className="h-8"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!resolutionById[gate.id]?.trim() || resolvingId !== null}
                    >
                      {resolving ? <Loader2 className="animate-spin" /> : null}
                      {translate(
                        'auto.components.orchestration.DecisionGateAttention.submit',
                        'Resolve'
                      )}
                    </Button>
                  </form>
                )}
              </section>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
