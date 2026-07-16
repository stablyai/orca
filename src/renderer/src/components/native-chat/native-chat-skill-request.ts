import type { DiscoveredSkill } from '../../../../shared/skills'

export type NativeChatSkillRequest = {
  refresh: (forceReload?: boolean) => void
  cancel: () => void
}

export function createNativeChatSkillRequest(args: {
  cwd: string
  list: (cwd: string, forceReload: boolean) => Promise<DiscoveredSkill[]>
  apply: (skills: DiscoveredSkill[]) => void
}): NativeChatSkillRequest {
  let generation = 0
  let cancelled = false
  return {
    refresh(forceReload = false): void {
      const requestGeneration = ++generation
      // Why: once the effective inventory is invalidated, keeping the previous
      // list clickable would violate the callable-for-this-turn invariant.
      args.apply([])
      void args
        .list(args.cwd, forceReload)
        .then((skills) => {
          if (!cancelled && requestGeneration === generation) {
            args.apply(skills)
          }
        })
        .catch(() => {
          if (!cancelled && requestGeneration === generation) {
            args.apply([])
          }
        })
    },
    cancel(): void {
      cancelled = true
    }
  }
}
