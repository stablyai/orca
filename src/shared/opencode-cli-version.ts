import { compareAppVersions, isValidAppVersion } from './app-version'

// These releases drop a bare --prompt (submitted before agent/model load); 2.0.19 fixed it upstream.
export const OPENCODE_NATIVE_PROMPT_VERSIONS = [
  '2.0.12',
  '2.0.13',
  '2.0.14',
  '2.0.15',
  '2.0.16',
  '2.0.17',
  '2.0.18'
] as const

export type OpenCodeCliCapabilities = {
  version: string | null
  pluginApi: 'v1' | 'v2' | 'unknown'
  promptMode: 'submit' | 'prefill' | 'unknown'
  v1SessionPolicyFiltersTools: boolean
}

export function parseOpenCodeCliVersion(output: string | null | undefined): string | null {
  const version = output
    ?.trim()
    .match(/^(?:opencode\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i)?.[1]
  return version && isValidAppVersion(version) ? version : null
}

export function getOpenCodeCliCapabilities(
  output: string | null | undefined
): OpenCodeCliCapabilities {
  const version = parseOpenCodeCliVersion(output)
  const major = version?.split('.')[0]
  return {
    version,
    pluginApi: major === '1' ? 'v1' : major === '2' ? 'v2' : 'unknown',
    v1SessionPolicyFiltersTools:
      major === '1' && version !== null && compareAppVersions(version, '1.3.0') >= 0,
    promptMode:
      major === '1'
        ? 'submit'
        : OPENCODE_NATIVE_PROMPT_VERSIONS.some((supported) => supported === version)
          ? 'prefill'
          : 'unknown'
  }
}
