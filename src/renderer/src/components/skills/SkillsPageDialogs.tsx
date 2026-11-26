import { SkillShareDialog } from './sharing/SkillShareDialog'
import { SkillInstallDialog } from './installation/SkillInstallDialog'
import { SkillInstallManagementDialog } from './installation/SkillInstallManagementDialog'
import type { DiscoveredSkill } from '../../../../shared/skills/discovery/skills'

export function SkillsPageDialogs({
  shareSkills,
  installLink,
  installOpen,
  managementOpen,
  onCloseShare,
  onInstallOpenChange,
  onManagementOpenChange
}: {
  shareSkills: DiscoveredSkill[]
  installLink: string
  installOpen: boolean
  managementOpen: boolean
  onCloseShare: () => void
  onInstallOpenChange: (open: boolean) => void
  onManagementOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <>
      <SkillShareDialog
        skills={shareSkills}
        open={shareSkills.length > 0}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            onCloseShare()
          }
        }}
      />
      <SkillInstallDialog
        key={installLink || 'manual-install'}
        open={installOpen}
        initialLink={installLink}
        onOpenChange={onInstallOpenChange}
      />
      <SkillInstallManagementDialog open={managementOpen} onOpenChange={onManagementOpenChange} />
    </>
  )
}
