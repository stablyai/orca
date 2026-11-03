import { useAppStore } from '@/store'

/** Experimental gate for every orchestration panel mount; read live so toggling needs no restart. */
export function useOrchestrationPanelEnabled(): boolean {
  return useAppStore((state) => state.settings?.experimentalOrchestrationPanel === true)
}
