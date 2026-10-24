import type { RefinementCtx } from 'zod'
import { pluginExecutionAllows, type PluginExecutionProfile } from './plugin-execution-profile'

type V2RuleSubject = {
  execution: PluginExecutionProfile
  pluginApi?: number
  contributes: { agents: readonly unknown[] }
}

/** Format 2 rules that are not about shape. */
export function validatePluginManifestV2Rules(manifest: V2RuleSubject, ctx: RefinementCtx): void {
  if (
    manifest.pluginApi !== undefined &&
    !pluginExecutionAllows(manifest.execution, 'sandboxed-ui')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['pluginApi'],
      message: `${manifest.execution} plugins never call the host API; remove pluginApi`
    })
  }
  // Why reserved: the key is kept for coding-agent definitions, whose file format is not defined
  // yet; accepting files now would let plugins ship something Orca silently ignores.
  if (manifest.contributes.agents.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['contributes', 'agents'],
      message: 'is reserved for coding-agent definitions and must be empty for now'
    })
  }
}
