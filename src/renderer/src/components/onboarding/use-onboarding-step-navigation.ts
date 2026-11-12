import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { resolveStepIndex, type OnboardingStepSkipOptions } from './onboarding-flow-state'

export function useOnboardingStepNavigation(
  setStepIndex: Dispatch<SetStateAction<number>>,
  skipOptions: OnboardingStepSkipOptions,
  stepIndex: number
) {
  const back = useCallback(() => {
    setStepIndex((index) => resolveStepIndex(index - 1, skipOptions, 'backward'))
  }, [setStepIndex, skipOptions])

  const jumpToStep = useCallback(
    (idx: number) => {
      setStepIndex(resolveStepIndex(idx, skipOptions, idx < stepIndex ? 'backward' : 'forward'))
    },
    [setStepIndex, skipOptions, stepIndex]
  )

  return { back, jumpToStep }
}
