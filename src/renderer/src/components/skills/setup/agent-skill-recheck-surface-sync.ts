import { notifyInstalledAgentSkillsRefreshed } from '@/hooks/skills/discovery/useInstalledAgentSkills'
import { refreshSkillFreshness } from '@/hooks/skills/freshness/useSkillFreshness'

export function syncSurfacesAfterAgentSkillRecheck(freshnessSkillName?: string): void {
  notifyInstalledAgentSkillsRefreshed()
  if (freshnessSkillName) {
    void refreshSkillFreshness()
  }
}

export function recheckSurfacesAfterAgentSkillInstall(
  onRecheck: () => void | Promise<unknown>,
  freshnessSkillName?: string
): void {
  void Promise.resolve(onRecheck()).then(() => {
    syncSurfacesAfterAgentSkillRecheck(freshnessSkillName)
  })
}
