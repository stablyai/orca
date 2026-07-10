import { isRuntimeProviderSearchQueryWithinLimit } from '@/runtime/runtime-provider-search-bounds'

export function getLinearProjectSearchRequestQuery(query: string): string | null {
  return isRuntimeProviderSearchQueryWithinLimit(query) ? query : null
}
