import type { TuiAgent } from './agent-launch/catalog/tui-agent'

/** Text-generation provider that runs on this Mac's Apple Foundation Models stack. */
export const ON_DEVICE_TEXT_GENERATION_ID = 'on-device'
export type OnDeviceTextGenerationId = typeof ON_DEVICE_TEXT_GENERATION_ID

/** Every id an AI text-generation choice or model-selection map may hold. */
export type TextGenerationAgentId = TuiAgent | OnDeviceTextGenerationId

export const ON_DEVICE_TEXT_GENERATION_MODEL_ID = 'apple-foundation-model'

/**
 * Measured on macOS 26: the model window holds 8192 tokens, and roughly 20k characters of
 * diff stay inside it. Beyond that the model refuses the request, so callers must fail loudly
 * instead of trimming: a truncated diff yields a confidently wrong commit message.
 */
export const ON_DEVICE_TEXT_GENERATION_CHAR_BUDGET = 20_000

/** macOS 26 is the first release with Foundation Models. */
const ON_DEVICE_MINIMUM_MACOS_MAJOR = 26

const ON_DEVICE_MODEL_ARGUMENT_PREFIX = '--orca-on-device-model='

/** Carried into the renderer at window creation: a build without the helper must not offer it. */
export function formatOnDeviceModelArgument(installed: boolean): string {
  return `${ON_DEVICE_MODEL_ARGUMENT_PREFIX}${installed ? '1' : '0'}`
}

/** Absent means the window did not ask, which only happens on unsupported hosts. */
export function parseOnDeviceModelArgument(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === `${ON_DEVICE_MODEL_ARGUMENT_PREFIX}1`)
}

export type OnDeviceHostFacts = {
  platform: string
  arch: string
  /** macOS product version, as `process.getSystemVersion()` reports it (e.g. "26.1"). */
  osRelease: string
  /** Whether this build actually shipped the helper. */
  helperInstalled?: boolean
}

export function isOnDeviceTextGenerationId(
  id: string | null | undefined
): id is OnDeviceTextGenerationId {
  return id === ON_DEVICE_TEXT_GENERATION_ID
}

export function macosProductMajorVersion(version: string): number | null {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major > 0 ? major : null
}

/** Cheap static gate. The model can still be unavailable (disabled in Settings, no Apple Silicon). */
export function onDeviceTextGenerationSupported(host: OnDeviceHostFacts): boolean {
  if (host.platform !== 'darwin' || host.arch !== 'arm64' || !host.helperInstalled) {
    return false
  }
  const major = macosProductMajorVersion(host.osRelease)
  return major !== null && major >= ON_DEVICE_MINIMUM_MACOS_MAJOR
}
