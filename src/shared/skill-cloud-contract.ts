import type { SkillPackageManifestV1 } from './skill-package-manifest'
import type { SkillBundleManifestV1 } from './skill-bundle-manifest'

export type SkillCloudOptions = {
  apiUrl?: string
  authToken?: string
}

export type SkillCloudInstallTarget = 'local' | 'remote'

export type SkillCloudOperation<T> =
  | { status: 'ok'; value: T }
  | { status: 'unconfigured'; message: string }
  | { status: 'reconnect-required' }

export type SkillCloudVersion = {
  packageId: string
  versionId: string
  name: string
  description: string
  packageDigest: string
  archiveSha256: string
  compressedBytes: number
  createdAt: string
  releaseNotes: string
  manifest: SkillPackageManifestV1 | SkillBundleManifestV1
}

export type SkillCloudShare = {
  id: string
  url: string
}

export type SkillCloudOwnedShare = SkillCloudShare & {
  packageId: string
  name: string
  description: string
  createdAt: string
  expiresAt?: string
}

export type SkillCloudDownloadGrant = {
  grant: { url: string; expiresAt: string }
  version: SkillCloudVersion
}

export type SkillCloudPackageDetails = {
  id: string
  name: string
  description: string
  createdAt: string
  canManage: boolean
  versions: SkillCloudVersion[]
  management?: {
    shares: {
      id: string
      url?: string
      pinnedVersionId?: string
      createdAt: string
      expiresAt?: string
    }[]
  }
}

export type SkillCloudPublishRequest = SkillCloudOptions & {
  archivePath: string
  archiveSha256: string
  compressedBytes: number
  packageId: string
  idempotencyKey?: string
  releaseNotes: string
  pinnedVersionId?: string
  onProgress?: (progress: {
    phase: 'uploading' | 'finalizing'
    bytesSent: number
    totalBytes: number
  }) => void
  signal?: AbortSignal
}

export type SkillCloudPublishResult = {
  version: SkillCloudVersion
  share: SkillCloudShare
}
