import { notifyInstalledAgentSkillsRefreshed } from '@/hooks/useInstalledAgentSkills'
import { refreshSkillFreshness } from '@/hooks/useSkillFreshness'

/** Publishes a completed re-check to presence and optional local-freshness surfaces. */
export function syncSurfacesAfterAgentSkillRecheck(freshnessSkillName?: string): void {
  notifyInstalledAgentSkillsRefreshed()
  if (freshnessSkillName) {
    void refreshSkillFreshness()
  }
}

export function recheckSurfacesAfterAgentSkillTerminal(
  onRecheck: () => void | Promise<unknown>,
  freshnessSkillName?: string
): void {
  void Promise.resolve(onRecheck()).then(() => {
    syncSurfacesAfterAgentSkillRecheck(freshnessSkillName)
  })
}
