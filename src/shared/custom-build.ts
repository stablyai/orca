export type CustomBuildInfo = {
  id: string
  baseVersion: string
  source?: { repository: string; commit: string }
  profileMode: 'isolated-preview' | 'interactive-preview' | 'shared-profile'
  changes: readonly {
    id: string
    title: string
    pullRequest?: { number: number; headSha: string; url: string }
  }[]
}

declare const ORCA_CUSTOM_BUILD_INFO: CustomBuildInfo | null

export function getCustomBuildInfo(): CustomBuildInfo | null {
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- absent outside the Electron build; a bare read throws.
  return typeof ORCA_CUSTOM_BUILD_INFO === 'undefined' ? null : ORCA_CUSTOM_BUILD_INFO
}
