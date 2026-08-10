import {
  GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY,
  GIT_INDEX_PRESERVING_DISCARD_UPDATE_REQUIRED_MESSAGE
} from './protocol-version'

export function assertGitIndexPreservingDiscardCapability(status: unknown): void {
  if (!status || typeof status !== 'object') {
    throw new Error(GIT_INDEX_PRESERVING_DISCARD_UPDATE_REQUIRED_MESSAGE)
  }
  const capabilities = (status as { capabilities?: unknown }).capabilities
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === 'string') ||
    !capabilities.includes(GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY)
  ) {
    throw new Error(GIT_INDEX_PRESERVING_DISCARD_UPDATE_REQUIRED_MESSAGE)
  }
}
