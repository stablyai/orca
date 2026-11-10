import type {
  PiUsageRange,
  PiUsageScope,
  PiUsageSnapshot
} from '../../../../../shared/pi-usage-types'
import {
  createUsageProviderSlice,
  type ProviderUsageSlice,
  type UsageProviderTypes
} from './usage-provider-slices'

type PiUsageTypes = UsageProviderTypes<PiUsageScope, PiUsageRange, PiUsageSnapshot>

export type PiUsageSlice = ProviderUsageSlice<'pi', 'Pi', PiUsageTypes>

export const createPiUsageSlice = createUsageProviderSlice<'pi', 'Pi', PiUsageTypes>({
  prefix: 'pi',
  name: 'Pi',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.piUsage,
  hasCachedData: (state) => state.hasAnyPiData
})
