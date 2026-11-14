import { beforeAll } from 'vitest'

export function prepareReleaseFixtures<T>(
  refs: readonly string[],
  load: (ref: string) => Promise<T>
) {
  const results = new Map<string, { value: T } | { error: unknown }>()
  for (const ref of refs) {
    beforeAll(async () => {
      try {
        results.set(ref, { value: await load(ref) })
      } catch (error) {
        results.set(ref, { error })
      }
    }, 180_000)
  }
  return (ref: string): T => {
    const result = results.get(ref)
    if (!result) {
      throw new Error(`Historical release fixture was not prepared: ${ref}`)
    }
    if ('error' in result) {
      throw result.error
    }
    return result.value
  }
}
