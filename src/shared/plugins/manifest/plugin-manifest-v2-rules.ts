import type { RefinementCtx } from 'zod'
import type { PluginCapability } from '../capabilities/plugin-capabilities'
import {
  pluginExecutionAllows,
  type PluginExecutionProfile
} from '../contributions/plugin-execution-profile'
import { pluginCapabilityReachable } from '../capabilities/plugin-capability-reach'
import { orcaEngineRangeSchema, satisfiesOrcaEngineRange } from './plugin-manifest-engine-range'
import { PLUGIN_DERIVED_PUBLISHER_SINCE } from './plugin-schema-field-docs'

type V2RuleSubject = {
  execution: PluginExecutionProfile
  pluginApi?: number
  capabilities: readonly PluginCapability[]
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
  manifest.capabilities.forEach((capability, index) => {
    if (!pluginCapabilityReachable(capability.kind, manifest.execution)) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', index, 'kind'],
        message: `${capability.kind} needs the trusted-worker execution profile; ${manifest.execution} plugins can't use it, so remove it or add a worker`
      })
    }
  })
}

/** Why authoring only: Orca before PLUGIN_DERIVED_PUBLISHER_SINCE requires `publisher`, so a
 *  manifest without it must say "requires Orca X" there instead of failing to parse. */
export function validateOmittedPublisherFloor(
  manifest: { publisher?: string; engines: { orca: string } },
  ctx: RefinementCtx
): void {
  if (
    manifest.publisher !== undefined ||
    !orcaEngineRangeSchema.safeParse(manifest.engines.orca).success ||
    satisfiesOrcaEngineRange(manifest.engines.orca.slice(2), `>=${PLUGIN_DERIVED_PUBLISHER_SINCE}`)
  ) {
    return
  }
  ctx.addIssue({
    code: 'custom',
    path: ['engines', 'orca'],
    message: `must be at least >=${PLUGIN_DERIVED_PUBLISHER_SINCE} when publisher is left out, because older Orca requires publisher`
  })
}
