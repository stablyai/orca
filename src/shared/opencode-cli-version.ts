import { isValidAppVersion } from './app-version'

export type OpenCodeCliCapabilities = {
  version: string | null
  pluginApi: 'v1' | 'v2' | 'unknown'
  promptMode: 'submit' | 'prefill' | 'unknown'
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
    promptMode: major === '1' ? 'submit' : version === '2.0.16' ? 'prefill' : 'unknown'
  }
}
