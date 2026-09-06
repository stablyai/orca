import type { PlaneConnectArgs } from '../../../shared/plane-types'

export function buildPlaneConnectArgs(input: {
  selfHosted: boolean
  baseUrl: string
  workspaceSlug: string
  apiToken: string
}): PlaneConnectArgs {
  const baseUrl = input.selfHosted ? input.baseUrl.trim() : 'https://api.plane.so'
  return {
    baseUrl,
    workspaceSlug: input.workspaceSlug.trim(),
    apiToken: input.apiToken.trim(),
    ...(input.selfHosted ? { appUrl: baseUrl } : {})
  }
}
