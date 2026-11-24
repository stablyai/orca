import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  OrcaUninstallFinishAction,
  OrcaUninstallPlan,
  OrcaUninstallRunStepArgs,
  OrcaUninstallStep
} from '../../../../../../shared/uninstall/orca-uninstall-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import {
  markOrcaUninstallStepFailed,
  mergeOrcaUninstallStepResult,
  runOrcaUninstallSteps,
  shouldRemoveHookScriptsAfterAgentRetry
} from './orca-uninstall-plan-state'

export type OrcaUninstallPhase = 'idle' | 'running' | 'done'

export type OrcaUninstallModel = {
  plan: OrcaUninstallPlan | null
  loadFailed: boolean
  phase: OrcaUninstallPhase
  runningStep: OrcaUninstallStep | null
  /** `step` or `step:id` keys with a retry in flight. */
  retrying: ReadonlySet<string>
  start: () => void
  retry: (args: OrcaUninstallRunStepArgs) => void
  reload: () => void
  finish: (action: OrcaUninstallFinishAction) => void
}

export function orcaUninstallRetryKey(step: OrcaUninstallStep, id?: string): string {
  return id ? `${step}:${id}` : step
}

const failureDetail = (): string =>
  translate('settings.uninstall.stepFailed', 'Orca could not finish this step.')

/** Loads the plan on mount (the collapsed summary names every part) and drives the step runner. */
export function useOrcaUninstall(): OrcaUninstallModel {
  const mountedRef = useMountedRef()
  const [plan, setPlan] = useState<OrcaUninstallPlan | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [phase, setPhase] = useState<OrcaUninstallPhase>('idle')
  const [runningStep, setRunningStep] = useState<OrcaUninstallStep | null>(null)
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set())
  const planRef = useRef<OrcaUninstallPlan | null>(null)

  const applyPlan = useCallback((next: OrcaUninstallPlan): void => {
    planRef.current = next
    setPlan(next)
  }, [])

  const reload = useCallback((): void => {
    setLoadFailed(false)
    window.api.orcaUninstall.getPlan().then(
      (next) => {
        if (mountedRef.current) {
          applyPlan(next)
        }
      },
      (error) => {
        console.error('[uninstall] failed to read the uninstall plan:', error)
        if (mountedRef.current) {
          setLoadFailed(true)
        }
      }
    )
  }, [applyPlan, mountedRef])

  useEffect(() => {
    reload()
  }, [reload])

  const start = useCallback((): void => {
    const initial = planRef.current
    if (!initial || phase !== 'idle') {
      return
    }
    setPhase('running')
    void runOrcaUninstallSteps(
      initial,
      (args) => window.api.orcaUninstall.runStep(args),
      failureDetail(),
      (next, step) => {
        if (mountedRef.current) {
          applyPlan(next)
          setRunningStep(step)
        }
      }
    ).then(() => {
      if (mountedRef.current) {
        setPhase('done')
      }
    })
  }, [applyPlan, mountedRef, phase])

  const retry = useCallback(
    (args: OrcaUninstallRunStepArgs): void => {
      const run = (stepArgs: OrcaUninstallRunStepArgs): void => {
        const keys = stepArgs.only?.map((id) => orcaUninstallRetryKey(stepArgs.step, id)) ?? [
          orcaUninstallRetryKey(stepArgs.step)
        ]
        setRetrying((prev) => new Set([...prev, ...keys]))
        const fold = (update: (current: OrcaUninstallPlan) => OrcaUninstallPlan): void => {
          if (mountedRef.current && planRef.current) {
            // Into the latest plan, since retries can finish out of order.
            applyPlan(update(planRef.current))
          }
        }
        window.api.orcaUninstall
          .runStep(stepArgs)
          .then(
            (next) => {
              fold((current) => mergeOrcaUninstallStepResult(current, next, stepArgs))
              // The run kept the scripts for the agent that failed; now nothing uses them.
              if (
                stepArgs.step === 'agent-hooks' &&
                mountedRef.current &&
                planRef.current &&
                shouldRemoveHookScriptsAfterAgentRetry(planRef.current)
              ) {
                run({ step: 'hook-scripts' })
              }
            },
            (error) => {
              console.error(`[uninstall] retry of ${stepArgs.step} failed:`, error)
              fold((current) => markOrcaUninstallStepFailed(current, stepArgs, failureDetail()))
            }
          )
          .finally(() => {
            if (mountedRef.current) {
              setRetrying((prev) => new Set([...prev].filter((key) => !keys.includes(key))))
            }
          })
      }
      run(args)
    },
    [applyPlan, mountedRef]
  )

  const finish = useCallback((action: OrcaUninstallFinishAction): void => {
    window.api.orcaUninstall.finish(action).catch((error) => {
      console.error(`[uninstall] finish(${action}) failed:`, error)
      toast.error(translate('settings.uninstall.finishFailed', 'Orca could not do that.'))
    })
  }, [])

  return { plan, loadFailed, phase, runningStep, retrying, start, retry, reload, finish }
}
