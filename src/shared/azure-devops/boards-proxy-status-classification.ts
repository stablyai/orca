import type { PluginTaskSourceErrorCode } from '../plugins/plugin-task-source-contract'

/**
 * Translates a boards proxy HTTP status into the closed task source error
 * vocabulary. The host classifies so a plugin cannot report a failure as an
 * empty board. Pure and Electron-free so desktop and relay cannot drift.
 */

const CODE_BY_STATUS: Record<number, PluginTaskSourceErrorCode> = {
  400: 'validation',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  // The host answers 412 when Azure DevOps is not configured on this execution host.
  412: 'not_configured',
  429: 'rate_limited'
}

/** Null means success. Any unlisted non-2xx status is `unavailable`. */
export function classifyBoardsProxyStatus(status: number): PluginTaskSourceErrorCode | null {
  if (status >= 200 && status < 300) {
    return null
  }
  return CODE_BY_STATUS[status] ?? 'unavailable'
}
