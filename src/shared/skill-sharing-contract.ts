import type {
  SkillCloudOperation,
  SkillCloudPublishResult,
  SkillCloudVersion
} from './skill-cloud-contract'
import type {
  SkillInstallDestination,
  SkillInstallPreview,
  SkillInstallResult,
  SkillPackageIdentity,
  ManagedSkillInstall
} from './skill-install-contract'
import type {
  SkillBundleInstallPreview,
  SkillBundleInstallResult,
  SkillBundlePackageIdentity,
  SkillBundleSelectedSkill
} from './skill-bundle-install-contract'

// Why: a plain message survives Electron IPC, which drops error classes and fields.
export const SKILL_SHARE_NAME_TAKEN_ERROR = 'skill-share-name-taken'
/** The link shown as "Update link" was stopped or moved elsewhere before this publish. */
export const SKILL_SHARE_LINK_CHANGED_ERROR = 'skill-share-link-changed'

export type SkillSharePreview = {
  preparationId: string
  packageId: string
  versionId: string
  name: string
  description: string
  packageDigest: string
  skillCount?: number
  skills?: {
    id: string
    name: string
    description: string
    digest: string
    fileCount: number
    totalBytes: number
    scriptPaths: string[]
    executablePaths: string[]
  }[]
  archiveSha256: string
  fileCount: number
  totalBytes: number
  compressedBytes: number
  scriptPaths: string[]
  executablePaths: string[]
  expiresAt: string
  /** The package's existing link; publishing moves it to this version. */
  sharedLinkUrl?: string
}

export type SkillSharePublishInput = {
  preparationId: string
  releaseNotes: string
}

export type SkillSharePublishOperation = SkillCloudOperation<SkillCloudPublishResult>

export type SkillShareResolvedOperation = SkillCloudOperation<{
  id: string
  version: SkillCloudVersion
}>

export type SkillShareProgress = {
  preparationId: string
  phase: 'uploading' | 'finalizing' | 'publishing'
  bytesSent: number
  totalBytes: number
}

export type SkillInstallProgress = {
  operationId: string
  phase: 'authorizing' | 'installing'
  currentSkill?: {
    id: string
    name: string
    index: number
    total: number
  }
}

export type SkillShareInstallInput = {
  shareId: string
  operationId?: string
  versionId: string
  environmentId?: string
  destination: SkillInstallDestination
  /** Agents to place the skill for; omitted means every detected agent. */
  providers?: string[]
  conflictResolution?: 'replace-unmodified' | 'replace-and-discard-local' | 'cancel'
}

export type SkillPackageVersionInstallInput = Omit<SkillShareInstallInput, 'shareId'> & {
  packageId: string
  versionId: string
}

export type SkillPackageVersionInstallOperation =
  | { status: 'ok'; value: SkillInstallResult }
  | { status: 'unconfigured'; message: string }
  | { status: 'reconnect-required' }
  | { status: 'unsupported'; message: string }

/** A link can move to a newer version than the one reviewed; a package version cannot. */
export type SkillShareInstallOperation =
  | SkillPackageVersionInstallOperation
  | { status: 'version-changed' }

export type SkillBundleShareInstallInput = {
  shareId: string
  operationId?: string
  versionId: string
  environmentId?: string
  selectedSkillIds: string[]
  destination: SkillInstallDestination
  /** Agents to place the skills for; omitted means every detected agent. */
  providers?: string[]
  conflictDecisions?: {
    skillId: string
    resolution: 'keep-local' | 'replace-unmodified' | 'replace-and-discard-local'
  }[]
}

export type SkillBundlePackageVersionInstallInput = Omit<
  SkillBundleShareInstallInput,
  'shareId'
> & {
  packageId: string
  versionId: string
}

export type SkillBundlePackageVersionInstallOperation =
  | { status: 'ok'; value: SkillBundleInstallResult }
  | { status: 'unconfigured'; message: string }
  | { status: 'reconnect-required' }
  | { status: 'unsupported'; message: string }

export type SkillBundleShareInstallOperation =
  | SkillBundlePackageVersionInstallOperation
  | { status: 'version-changed' }

export type SkillBundleInstallPreviewInput = {
  environmentId?: string
  package: SkillBundlePackageIdentity
  selectedSkills: SkillBundleSelectedSkill[]
  destination: SkillInstallDestination
}

export type SkillBundleInstallPreviewOperation =
  | { status: 'ok'; value: SkillBundleInstallPreview }
  | { status: 'unsupported'; message: string }

export type SkillInstallPreviewInput = {
  environmentId?: string
  package: SkillPackageIdentity
  name: string
  destination: SkillInstallDestination
}

export type SkillInstallPreviewOperation =
  | { status: 'ok'; value: SkillInstallPreview }
  | { status: 'unsupported'; message: string }

export type SkillRemoveInput = {
  environmentId?: string
  name: string
  destination: SkillInstallDestination
  conflictResolution?: 'replace-and-discard-local' | 'cancel'
}

export type SkillRemoveOperation =
  | { status: 'ok'; value: SkillInstallResult }
  | { status: 'unsupported'; message: string }

export type SkillInstallCancelInput = {
  operationId: string
  environmentId?: string
}

export type ManagedSkillInstallListOperation =
  | { status: 'ok'; value: ManagedSkillInstall[] }
  | { status: 'unsupported'; message: string }
