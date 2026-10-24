import type { RefinementCtx } from 'zod'
import { pluginExecutionAllows, type PluginExecutionProfile } from '../plugin-execution-profile'

type V2RuleSubject = {
  execution: PluginExecutionProfile
  pluginApi?: number
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
}
