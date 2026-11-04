import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
  DEFAULT_SUBAGENT_DISPLAY_MODE
} from '../../../../../../shared/constants'

export function useWorktreeAgentDisplay() {
  return useAppStore(
    useShallow((s) => ({
      agentActivityDisplayMode: s.agentActivityDisplayMode ?? DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
      showAgentModels: s.showAgentModels !== false,
      showSubagents: s.showSubagents !== false,
      subagentDisplayMode: s.subagentDisplayMode ?? DEFAULT_SUBAGENT_DISPLAY_MODE
    }))
  )
}
