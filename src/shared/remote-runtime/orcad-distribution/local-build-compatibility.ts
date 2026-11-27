import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from './local-build-compatibility-contract'

export const LOCAL_BUILD_COMPATIBILITY_FILENAME = 'orca-local-build.json'
export const LOCAL_BUILD_COMPATIBILITY_FORMAT_VERSION =
  LOCAL_BUILD_COMPATIBILITY_CONTRACT.formatVersion
export const ORCA_APP_ID = LOCAL_BUILD_COMPATIBILITY_CONTRACT.appId

export type LocalBuildArchitecture = 'arm64' | 'x64'

export type LocalBuildCompatibility = {
  formatVersion: number
  appId: string
  buildId: string
  version: string
  commit: string
  stateSchemaVersion: number
  readableStateSchemaVersions: number[]
  daemonProtocolVersion: number
  attachableDaemonProtocolVersions: number[]
  platform: 'darwin'
  architecture: LocalBuildArchitecture
}

function isIntegerArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every((entry) => Number.isSafeInteger(entry) && entry > 0)
  )
}

export function parseLocalBuildCompatibility(value: unknown): LocalBuildCompatibility {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The selected build has invalid compatibility metadata.')
  }
  const record = value as Record<string, unknown>
  const architecture = record.architecture
  if (
    record.formatVersion !== LOCAL_BUILD_COMPATIBILITY_FORMAT_VERSION ||
    record.appId !== ORCA_APP_ID ||
    typeof record.buildId !== 'string' ||
    record.buildId.length === 0 ||
    record.buildId.length > 200 ||
    typeof record.version !== 'string' ||
    record.version.length === 0 ||
    record.version.length > 100 ||
    typeof record.commit !== 'string' ||
    record.commit.length === 0 ||
    record.commit.length > 100 ||
    !Number.isSafeInteger(record.stateSchemaVersion) ||
    Number(record.stateSchemaVersion) <= 0 ||
    !isIntegerArray(record.readableStateSchemaVersions) ||
    !Number.isSafeInteger(record.daemonProtocolVersion) ||
    Number(record.daemonProtocolVersion) <= 0 ||
    !isIntegerArray(record.attachableDaemonProtocolVersions) ||
    record.platform !== 'darwin' ||
    (architecture !== 'arm64' && architecture !== 'x64')
  ) {
    throw new Error('The selected build has invalid compatibility metadata.')
  }
  if (
    !(record.readableStateSchemaVersions as number[]).includes(
      record.stateSchemaVersion as number
    ) ||
    !(record.attachableDaemonProtocolVersions as number[]).includes(
      record.daemonProtocolVersion as number
    )
  ) {
    throw new Error('The selected build has inconsistent compatibility metadata.')
  }
  return record as LocalBuildCompatibility
}

export function getLocalBuildCompatibilityError(
  target: LocalBuildCompatibility,
  currentStateSchemaVersion: number,
  liveDaemonProtocols: readonly number[]
): string | null {
  if (!target.readableStateSchemaVersions.includes(currentStateSchemaVersion)) {
    return `This build cannot read Orca workspace state schema ${currentStateSchemaVersion}. Your workspace was not changed.`
  }
  const unsupportedProtocols = liveDaemonProtocols.filter(
    (protocol) => !target.attachableDaemonProtocolVersions.includes(protocol)
  )
  if (unsupportedProtocols.length > 0) {
    return `This build cannot reconnect terminal daemon protocol ${unsupportedProtocols.join(', ')}. Close those terminals or choose a compatible build.`
  }
  return null
}
