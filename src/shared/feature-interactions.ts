import { FEATURE_INTERACTION_IDS, type FeatureInteractionId } from './feature-interaction-catalog'
import {
  isFeatureInteractionUsageBucket,
  type FeatureInteractionUsageBucket
} from './feature-interaction-usage-buckets'

export {
  FEATURE_INTERACTIONS,
  FEATURE_INTERACTION_IDS,
  type FeatureInteractionDefinition,
  type FeatureInteractionId
} from './feature-interaction-catalog'
export {
  FEATURE_INTERACTION_CATEGORIES,
  FEATURE_INTERACTION_CATEGORY_BY_ID,
  getFeatureInteractionCategory,
  type FeatureInteractionCategory
} from './feature-interaction-categories'
export {
  compareFeatureInteractionUsageBuckets,
  FEATURE_INTERACTION_USAGE_BUCKETS,
  FEATURE_INTERACTION_USAGE_BUCKET_SPECS,
  getFeatureInteractionUsageBucket,
  isFeatureInteractionUsageBucket,
  type FeatureInteractionUsageBucket
} from './feature-interaction-usage-buckets'

export type FeatureInteractionRecord = {
  /** Unix timestamp in milliseconds for the first local interaction. */
  firstInteractedAt: number
  /** Number of local interactions recorded for this feature. */
  interactionCount: number
}

export type FeatureInteractionState = Partial<
  Record<FeatureInteractionId, FeatureInteractionRecord>
>

export type FeatureInteractionTelemetryBucketState = Partial<
  Record<FeatureInteractionId, FeatureInteractionUsageBucket>
>

export function isFeatureInteractionId(value: unknown): value is FeatureInteractionId {
  return (
    typeof value === 'string' && FEATURE_INTERACTION_IDS.includes(value as FeatureInteractionId)
  )
}

export function hasFeatureInteraction(
  state: FeatureInteractionState | null | undefined,
  id: FeatureInteractionId
): boolean {
  return normalizeFeatureInteractionRecord(state?.[id]) !== null
}

export function normalizeFeatureInteractionTelemetryBuckets(
  value: unknown
): FeatureInteractionTelemetryBucketState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const input = value as Record<string, unknown>
  const out: FeatureInteractionTelemetryBucketState = {}
  for (const id of FEATURE_INTERACTION_IDS) {
    const bucket = input[id]
    if (isFeatureInteractionUsageBucket(bucket)) {
      out[id] = bucket
    }
  }
  return out
}

export function normalizeFeatureInteractions(value: unknown): FeatureInteractionState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const input = value as Record<string, unknown>
  const out: FeatureInteractionState = {}
  for (const id of FEATURE_INTERACTION_IDS) {
    const record = normalizeFeatureInteractionRecord(input[id])
    if (record) {
      out[id] = record
    }
  }
  return out
}

function normalizeFeatureInteractionRecord(value: unknown): FeatureInteractionRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  const firstInteractedAt = input.firstInteractedAt
  if (
    typeof firstInteractedAt !== 'number' ||
    !Number.isFinite(firstInteractedAt) ||
    firstInteractedAt < 0
  ) {
    return null
  }
  const rawInteractionCount = input.interactionCount
  const interactionCount =
    typeof rawInteractionCount === 'number' &&
    Number.isInteger(rawInteractionCount) &&
    rawInteractionCount > 0
      ? rawInteractionCount
      : 1
  return { firstInteractedAt, interactionCount }
}
