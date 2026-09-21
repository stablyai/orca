import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'

export const SKILL_WARNING_PREVIEW_SHARE_ID = 'dev-warning-preview'

export function isSkillWarningPreviewEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    String(import.meta.env.VITE_SKILL_WARNING_PREVIEW).toLowerCase() === 'true'
  )
}

export async function skillWarningPreviewVersionForShare(
  shareId: string
): Promise<SkillCloudVersion | null> {
  if (!isSkillWarningPreviewEnabled() || shareId !== SKILL_WARNING_PREVIEW_SHARE_ID) {
    return null
  }
  const { skillWarningPreviewVersion } = await import('./skill-warning-preview-version')
  return skillWarningPreviewVersion()
}

type SkillShareResolution = Awaited<ReturnType<typeof window.api.skills.resolveShare>>

export async function resolveSkillShareForInstall(shareId: string): Promise<SkillShareResolution> {
  const previewVersion = await skillWarningPreviewVersionForShare(shareId)
  return previewVersion
    ? { status: 'ok', value: { id: shareId, version: previewVersion } }
    : window.api.skills.resolveShare(shareId)
}
