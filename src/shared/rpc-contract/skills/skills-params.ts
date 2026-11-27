import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { SkillDiscoveryTargetSchema } from '../../skills/discovery/skills'

export const SkillsGetInstallProgressParams = lazyZodSchema(() =>
  z.object({ operationId: z.string().min(1).max(128) }).strict()
)

export const SkillsCancelInstallParams = lazyZodSchema(() =>
  z.object({ operationId: z.string().min(1).max(128) }).strict()
)

export const SkillsDiscoverParams = lazyZodSchema(() => SkillDiscoveryTargetSchema.default({}))
