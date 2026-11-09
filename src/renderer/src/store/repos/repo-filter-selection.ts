// Preserve equal filter arrays on catalog refresh or six identity-sensitive subscribers, including App root, rerender.
export function retainValidFilterRepoIds(
  filterRepoIds: string[],
  validRepoIds: ReadonlySet<string>
): string[]
export function retainValidFilterRepoIds(
  filterRepoIds: readonly string[],
  validRepoIds: ReadonlySet<string>
): readonly string[]
export function retainValidFilterRepoIds(
  filterRepoIds: readonly string[],
  validRepoIds: ReadonlySet<string>
): readonly string[] {
  const valid = (id: string) => validRepoIds.has(id.slice(id.indexOf('\0') + 1))
  return filterRepoIds.every(valid) ? filterRepoIds : filterRepoIds.filter(valid)
}
