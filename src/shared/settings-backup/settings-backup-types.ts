import type { GlobalSettings } from '../global-settings-types'
import type { SettingsBackupSectionId } from './settings-backup-catalog'

export const SETTINGS_BACKUP_FORMAT = 'orca-settings-backup' as const
export const SETTINGS_BACKUP_FORMAT_VERSION = 1

/** On-disk shape of a settings backup file. */
export type SettingsBackupFile = {
  format: typeof SETTINGS_BACKUP_FORMAT
  formatVersion: number
  createdAt: string
  appVersion: string
  sourcePlatform: NodeJS.Platform
  sections: SettingsBackupSectionId[]
  settings: Partial<GlobalSettings>
  /** SHA-256 of the canonical JSON of every other field; detects corruption and hand edits. */
  integrity: { algorithm: 'sha256'; digest: string }
}

export type SettingsBackupExportRequest = {
  sections: SettingsBackupSectionId[]
}

export type SettingsBackupExportResult =
  | {
      status: 'saved'
      filePath: string
      exportedKeyCount: number
      /** Keys left out because their value looked like a credential. */
      excludedSecretKeys: string[]
    }
  | { status: 'canceled' }
  | { status: 'failed'; message: string }

export type SettingsBackupChangeKind = 'changed' | 'added'

/** Why an incoming value will not be applied unless the user opts in, or at all. */
export type SettingsBackupSkipReason =
  | 'other-platform'
  | 'secret-like-value'
  | 'unsupported-key'
  | 'protected-key'
  | 'invalid-value'

export type SettingsBackupDiffEntry = {
  key: string
  section: SettingsBackupSectionId | null
  kind: SettingsBackupChangeKind
  currentValue: unknown
  incomingValue: unknown
  /** Present when the entry is shown but should not be applied by default (or cannot be). */
  skipReason?: SettingsBackupSkipReason
  /** False when nothing the user picks can apply this entry. */
  applicable: boolean
}

export type SettingsBackupImportPreview =
  | {
      status: 'ready'
      /** Opaque handle the apply call must echo back; the file is never re-read from the renderer. */
      previewId: string
      fileName: string
      createdAt: string
      appVersion: string
      sourcePlatform: NodeJS.Platform
      sameAppVersion: boolean
      newerAppVersion: boolean
      sections: SettingsBackupSectionId[]
      entries: SettingsBackupDiffEntry[]
      unchangedKeyCount: number
    }
  | { status: 'canceled' }
  | { status: 'invalid'; reason: SettingsBackupInvalidReason; message: string }

export type SettingsBackupInvalidReason =
  | 'unreadable'
  | 'too-large'
  | 'not-json'
  | 'wrong-format'
  | 'newer-format'
  | 'integrity-mismatch'

export type SettingsBackupApplyRequest = {
  previewId: string
  keys: string[]
}

export type SettingsBackupApplyResult =
  | {
      status: 'applied'
      appliedKeys: string[]
      recoveryPointId: string | null
    }
  | { status: 'expired' }
  | { status: 'failed'; message: string; rolledBack: boolean }

export type SettingsRecoveryPointSummary = {
  id: string
  createdAt: string
  reason: 'before-import' | 'before-restore'
  keyCount: number
}

export type SettingsRecoveryRestoreResult =
  | { status: 'restored'; restoredKeys: string[] }
  | { status: 'not-found' }
  | { status: 'failed'; message: string }
