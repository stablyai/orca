import { useMemo } from 'react'
import type { SessionOptionsSurface } from '../../../../shared/native-chat-session-options'

export function useStructuredSessionOptionsSurface(
  optionSnapshot: ReturnType<SessionOptionsSurface['getSnapshot']>,
  setStructuredOption: (id: string, value: string | boolean) => Promise<boolean>
): SessionOptionsSurface {
  return useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption: async (id, value) => {
        await setStructuredOption(id, value)
        return { snapshot: optionSnapshot }
      },
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setStructuredOption]
  )
}
