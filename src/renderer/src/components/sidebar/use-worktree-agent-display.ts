import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE } from '../../../../shared/constants'

export function useWorktreeAgentDisplay() {
  return useAppStore(
    useShallow((s) => ({
      agentActivityDisplayMode: s.agentActivityDisplayMode ?? DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
      showAgentModels: s.showAgentModels !== false
    }))
  )
}
