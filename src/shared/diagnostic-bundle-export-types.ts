export const DIAGNOSTIC_BUNDLE_CATEGORIES = [
  'app',
  'system',
  'observability',
  'memory',
  'crash-reports',
  'native-minidumps',
  'runtime-counts',
  'terminal-lifecycle',
  'windows-events',
  'windows-wsl',
  'windows-shells',
  'macos-reports',
  'macos-shells',
  'linux-coredump',
  'linux-journal',
  'linux-shells'
] as const

export const MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES = 30 * 24 * 60

export type DiagnosticBundleCategory = (typeof DIAGNOSTIC_BUNDLE_CATEGORIES)[number]

export type DiagnosticBundleCategoryStatus = 'included' | 'skipped' | 'error' | 'truncated'

export type DiagnosticBundleCategoryResult = {
  category: DiagnosticBundleCategory
  status: DiagnosticBundleCategoryStatus
  reason?: string
  files: string[]
}

export type DiagnosticBundleFileManifest = {
  path: string
  category: DiagnosticBundleCategory | 'manifest'
  bytes: number
  sha256: string | null
}

export type DiagnosticBundleManifest = {
  schemaVersion: 1
  bundleId: string
  collectedAt: string
  appVersion: string
  orcaChannel: 'stable' | 'rc' | 'dev'
  platform: NodeJS.Platform
  arch: string
  lookbackMinutes: number
  categories: DiagnosticBundleCategoryResult[]
  files: DiagnosticBundleFileManifest[]
}

export type DiagnosticBundleExportArgs = {
  output?: string
  lookbackMinutes?: number
  include?: DiagnosticBundleCategory[]
  exclude?: DiagnosticBundleCategory[]
  open?: boolean
}

export type DiagnosticBundleExportResult = {
  bundleId: string
  outputPath: string
  bytes: number
  lookbackMinutes: number
  includedCategories: DiagnosticBundleCategory[]
  skippedCategories: DiagnosticBundleCategoryResult[]
  errorCategories: DiagnosticBundleCategoryResult[]
  fileCount: number
}
