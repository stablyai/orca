import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { pickSourceControlLaunchAgent } from '@/lib/source-control-launch-agent-selection'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'

type UseSourceControlAgentActionDialogOpenSyncArgs = {
  open: boolean
  preferredAgentId?: TuiAgent | null
  savedAgentId?: TuiAgent | null
  savedAgentArgs?: string | null
  savedCommandInputTemplate?: string | null
  defaultSaveTargetValue: string
  disabledAgents: TuiAgent[] | undefined
  settings: Pick<GlobalSettings, 'defaultTuiAgent'> | null | undefined
  refreshDetectedAgents: () => Promise<TuiAgent[]>
  setCommandTemplate: (value: string) => void
  setAgentArgs: (value: string) => void
  setSelectedAgent: Dispatch<SetStateAction<TuiAgent | null>>
  setSaveLaunchRecipe: (value: boolean) => void
  setSaveTargetValue: (value: string) => void
}

export function useSourceControlAgentActionDialogOpenSync({
  open,
  preferredAgentId,
  savedAgentId,
  savedAgentArgs,
  savedCommandInputTemplate,
  defaultSaveTargetValue,
  disabledAgents,
  settings,
  refreshDetectedAgents,
  setCommandTemplate,
  setAgentArgs,
  setSelectedAgent,
  setSaveLaunchRecipe,
  setSaveTargetValue
}: UseSourceControlAgentActionDialogOpenSyncArgs): {
  openCycle: number
  detectedOpenCycle: number | null
} {
  const openCycleRef = useRef(0)
  const wasOpenRef = useRef(false)
  const [openCycle, setOpenCycle] = useState(0)
  const [detectedOpenCycle, setDetectedOpenCycle] = useState<number | null>(null)

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    // Why: bump openCycle only on the rising edge of open so saved-receipt
    // auto-start resets per dialog session; dependency churn while already
    // open reuses the current cycle instead of silently re-arming a launch.
    const cycle = wasOpenRef.current ? openCycleRef.current : openCycleRef.current + 1
    if (!wasOpenRef.current) {
      openCycleRef.current = cycle
      setOpenCycle(cycle)
    }
    wasOpenRef.current = true
    setDetectedOpenCycle(null)
    setCommandTemplate(savedCommandInputTemplate ?? '{basePrompt}')
    setAgentArgs(savedAgentArgs ?? '')
    setSelectedAgent(preferredAgentId ?? savedAgentId ?? null)
    setSaveLaunchRecipe(true)
    setSaveTargetValue(defaultSaveTargetValue)
    let stale = false
    void refreshDetectedAgents()
      .then((nextAgents) => {
        if (stale || openCycleRef.current !== cycle) {
          return
        }
        setSelectedAgent(
          (current) =>
            current ??
            pickSourceControlLaunchAgent({
              savedAgent: preferredAgentId ?? savedAgentId,
              defaultAgent: settings?.defaultTuiAgent,
              detectedAgents: nextAgents,
              disabledAgents
            })
        )
        setDetectedOpenCycle(cycle)
      })
      .catch(() => {
        if (stale || openCycleRef.current !== cycle) {
          return
        }
        // Why: still mark detection complete so the dialog can surface status
        // copy instead of staying blocked behind a pending auto-start receipt.
        setDetectedOpenCycle(cycle)
      })
    return () => {
      stale = true
    }
  }, [
    defaultSaveTargetValue,
    disabledAgents,
    open,
    preferredAgentId,
    refreshDetectedAgents,
    savedAgentArgs,
    savedAgentId,
    savedCommandInputTemplate,
    setAgentArgs,
    setCommandTemplate,
    setSaveLaunchRecipe,
    setSaveTargetValue,
    setSelectedAgent,
    settings?.defaultTuiAgent
  ])

  return { openCycle, detectedOpenCycle }
}
