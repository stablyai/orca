import { notifyInstalledAgentSkillsRefreshed } from '@/hooks/useInstalledAgentSkills'
import { refreshSkillFreshness } from '@/hooks/useSkillFreshness'

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
