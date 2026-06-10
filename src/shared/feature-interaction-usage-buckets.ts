export const FEATURE_INTERACTION_USAGE_BUCKETS = [
  'count_1',
  'count_2',
  'count_3_4',
  'count_5_9',
  'count_10_19',
  'count_20_49',
  'count_50_99',
  'count_100_199',
  'count_200_499',
  'count_500_999',
  'count_1000_plus'
] as const
export type FeatureInteractionUsageBucket = (typeof FEATURE_INTERACTION_USAGE_BUCKETS)[number]

export const FEATURE_INTERACTION_USAGE_BUCKET_SPECS = [
  { bucket: 'count_1', min: 1 },
  { bucket: 'count_2', min: 2 },
  { bucket: 'count_3_4', min: 3 },
  { bucket: 'count_5_9', min: 5 },
  { bucket: 'count_10_19', min: 10 },
  { bucket: 'count_20_49', min: 20 },
  { bucket: 'count_50_99', min: 50 },
  { bucket: 'count_100_199', min: 100 },
  { bucket: 'count_200_499', min: 200 },
  { bucket: 'count_500_999', min: 500 },
  { bucket: 'count_1000_plus', min: 1000 }
] as const satisfies readonly {
  bucket: FeatureInteractionUsageBucket
  min: number
}[]

const FEATURE_INTERACTION_USAGE_BUCKET_INDEX = new Map<FeatureInteractionUsageBucket, number>(
  FEATURE_INTERACTION_USAGE_BUCKETS.map((bucket, index) => [bucket, index])
)

export function getFeatureInteractionUsageBucket(
  count: number
): FeatureInteractionUsageBucket | null {
  if (!Number.isInteger(count) || count <= 0) {
    return null
  }
  let bucket: FeatureInteractionUsageBucket | null = null
  for (const spec of FEATURE_INTERACTION_USAGE_BUCKET_SPECS) {
    if (count >= spec.min) {
      bucket = spec.bucket
    }
  }
  return bucket
}

export function compareFeatureInteractionUsageBuckets(
  a: FeatureInteractionUsageBucket,
  b: FeatureInteractionUsageBucket
): number {
  return (
    (FEATURE_INTERACTION_USAGE_BUCKET_INDEX.get(a) ?? -1) -
    (FEATURE_INTERACTION_USAGE_BUCKET_INDEX.get(b) ?? -1)
  )
}

export function isFeatureInteractionUsageBucket(
  value: unknown
): value is FeatureInteractionUsageBucket {
  return (
    typeof value === 'string' &&
    FEATURE_INTERACTION_USAGE_BUCKETS.includes(value as FeatureInteractionUsageBucket)
  )
}
