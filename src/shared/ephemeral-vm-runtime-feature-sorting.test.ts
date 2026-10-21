import { expect, it } from 'vitest'
import { featureIdentity, sortRuntimeFeatures } from './ephemeral-vm-runtime-feature-store'
import { mergeRuntimeFeatures } from './ephemeral-vm-runtime-rollback-projection'

it('computes each runtime identity once per sort with identical stable ordering', () => {
  let reads = 0
  const features = Array.from({ length: 2000 }, (_, i) => ({
    get id() {
      reads++
      return `vm-${(i * 173) % 1999}`
    },
    recipeId: i % 2 ? 'Éclair' : 'eclair',
    createdAt: i % 11
  }))
  const expected = [...features].sort((a, b) =>
    featureIdentity(a).localeCompare(featureIdentity(b))
  )
  expect(reads).toBeGreaterThan(20_000)
  reads = 0
  const sorted = sortRuntimeFeatures(features)
  expect(reads).toBe(2000)
  sorted.forEach((entry, index) => expect(entry).toBe(expected[index]))
  const required = { ...features[0], replacement: true }
  const merged = new Map(features.map((entry) => [featureIdentity(entry), entry]))
  merged.set(featureIdentity(required), required)
  const expectedMerged = [...merged.values()].sort((a, b) =>
    featureIdentity(a).localeCompare(featureIdentity(b))
  )
  reads = 0
  const actual = mergeRuntimeFeatures(features, [required])
  expect(reads).toBeLessThanOrEqual(4000)
  actual.forEach((entry, index) => expect(entry).toBe(expectedMerged[index]))
})
