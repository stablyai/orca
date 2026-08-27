import { translate } from '@/i18n/i18n'

const SKILL_INSTALL_ERROR_COPY = {
  enterShareLink: [
    'auto.components.skills.install.enterShareLink',
    'Enter an Orca skill share link.'
  ],
  shareUnavailable: [
    'auto.components.skills.install.shareUnavailable',
    'This share is unavailable. The link may be invalid, expired, or revoked.'
  ],
  reconnectBeforeInstalling: [
    'auto.components.skills.install.reconnectBeforeInstalling',
    'Reconnect your Orca account before installing.'
  ],
  requestedVersionVerificationFailed: [
    'auto.components.skills.install.requestedVersionVerificationFailed',
    'Installation failed before Orca could verify the requested version.'
  ],
  destinationAlreadyFinished: [
    'auto.components.skills.install.destinationAlreadyFinished',
    'The destination had already finished this installation.'
  ],
  inspectManagedFailed: [
    'auto.components.skills.install.inspectManagedFailed',
    'Orca could not inspect managed installs on this machine.'
  ],
  reconnectForVersionHistory: [
    'auto.components.skills.install.reconnectForVersionHistory',
    'Reconnect your Orca account to load version history.'
  ],
  versionHistoryUnavailable: [
    'auto.components.skills.install.versionHistoryUnavailable',
    'Version history is unavailable for this skill.'
  ],
  bundleSkillsMissing: [
    'auto.components.skills.install.bundleSkillsMissing',
    'This version does not contain any of the installed bundle skills.'
  ],
  reconnectBeforeVersionChange: [
    'auto.components.skills.install.reconnectBeforeVersionChange',
    'Reconnect your Orca account before changing versions.'
  ],
  versionVerificationFailed: [
    'auto.components.skills.install.versionVerificationFailed',
    'Orca could not verify the requested version.'
  ],
  removeFailed: [
    'auto.components.skills.install.removeFailed',
    'Orca could not safely remove this skill.'
  ],
  dialogInstallSharedSkills: [
    'auto.components.skills.SkillInstallDialog.01c5a14e01',
    'Install shared skills'
  ],
  dialogInstallSharedSkill: [
    'auto.components.skills.SkillInstallDialog.fcbec627cc',
    'Install shared skill'
  ],
  dialogOpening: ['auto.components.skills.SkillInstallDialog.opening', 'Opening this link…'],
  dialogClose: ['auto.components.skills.SkillInstallDialog.d198ec91e5', 'Close'],
  dialogChecking: ['auto.components.skills.SkillInstallReviewContent.69236de8d6', 'Checking…'],
  dialogInspect: ['auto.components.skills.SkillInstallReviewContent.157de228b4', 'Inspect skill'],
  dialogCancel: ['auto.components.skills.SkillInstallDialog.05588076a9', 'Cancel installation'],
  dialogInstalling: ['auto.components.skills.SkillInstallDialog.241e72f9d6', 'Installing…'],
  dialogRetry: ['auto.components.skills.SkillInstallDialog.59c3b76cdd', 'Retry install'],
  dialogInstall: ['auto.components.skills.SkillInstallDialog.39acb9e8f4', 'Install skill']
} as const satisfies Record<string, readonly [string, string]>

export type SkillInstallErrorId = keyof typeof SKILL_INSTALL_ERROR_COPY

export function translateSkillInstallError(id: SkillInstallErrorId): string {
  const [key, fallback] = SKILL_INSTALL_ERROR_COPY[id]
  return translate(key, fallback)
}
