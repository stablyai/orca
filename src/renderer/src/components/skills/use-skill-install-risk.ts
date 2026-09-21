import { useMemo } from 'react'
import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import { checklistItemsFromVersion } from './skill-package-checklist-items'
import { summarizeSkillInstallRisk } from './skill-package-install-risk'
import { isSkillBundleVersion } from './skill-share-version-summary'

export function useSkillInstallRisk(version: SkillCloudVersion | null) {
  return useMemo(
    () =>
      version && !isSkillBundleVersion(version)
        ? summarizeSkillInstallRisk(checklistItemsFromVersion(version), null)
        : null,
    [version]
  )
}
