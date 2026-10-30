import type {
  OmpUsageRange,
  OmpUsageScope,
  OmpUsageSnapshot
} from '../../../../shared/omp-usage-types'
import {
  createUsageProviderSlice,
  type ProviderUsageSlice,
  type UsageProviderTypes
} from './usage-provider-slices'

type OmpUsageTypes = UsageProviderTypes<OmpUsageScope, OmpUsageRange, OmpUsageSnapshot>

export type OmpUsageSlice = ProviderUsageSlice<'omp', 'Omp', OmpUsageTypes>

export const createOmpUsageSlice = createUsageProviderSlice<'omp', 'Omp', OmpUsageTypes>({
  prefix: 'omp',
  name: 'Omp',
  // omp's persisted daily totals are not location-attributed, so the corpus-wide view is the honest default.
  initialScope: 'all',
  initialRange: '30d',
  getApi: () => window.api.ompUsage,
  hasCachedData: (state) => state.hasAnyOmpData
})
