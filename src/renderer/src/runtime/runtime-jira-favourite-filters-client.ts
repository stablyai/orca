import {
  parseJiraFavouriteFilterList,
  type JiraFavouriteFilterList
} from '../../../shared/jira-favourite-filters'
import { JiraFavouriteFilterParams } from '../../../shared/rpc-contract/jira-favourite-filter-params'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'

export type JiraFavouriteFiltersResult =
  | { supported: false }
  | ({ supported: true } & JiraFavouriteFilterList)

const UNSUPPORTED_FAVOURITE_FILTERS = { supported: false } as const

export async function jiraListFavouriteFiltersForTarget(
  target: RuntimeClientTarget,
  siteId: string
): Promise<JiraFavouriteFiltersResult> {
  const args = JiraFavouriteFilterParams.parse({ siteId })
  if (target.kind === 'local' && !window.api.jira.listFavouriteFilters) {
    return UNSUPPORTED_FAVOURITE_FILTERS
  }
  let value: unknown
  try {
    value =
      target.kind === 'environment'
        ? await callRuntimeRpc<unknown>(target, 'jira.listFavouriteFilters', args, {
            timeoutMs: 30_000
          })
        : await window.api.jira.listFavouriteFilters(args)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'method_not_found'
    ) {
      return UNSUPPORTED_FAVOURITE_FILTERS
    }
    throw error
  }
  return { supported: true, ...parseJiraFavouriteFilterList(value, args.siteId) }
}
