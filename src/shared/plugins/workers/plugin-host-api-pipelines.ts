import { z } from 'zod'
import { spec, ALL_SURFACES, FRAMES_ONLY } from './plugin-host-method-spec'
import { PipelineControlParams } from '../../rpc-contract/pipeline-params'

const id = z.string().min(1).max(256)
export const PluginPipelineSummary = z.strictObject({
  id,
  workspaceId: id,
  title: z.string().max(120),
  stage: z.string().max(16),
  state: z.string().max(32),
  revision: z.number().int().min(0),
  fixCycles: z.number().int().min(0).max(2),
  reason: z.string().max(500).optional(),
  ready: z.boolean().nullable()
})

export const PLUGIN_PIPELINE_API = {
  'pipeline.read': spec({
    summary:
      'Reads bounded summaries of this plugin’s pipelines; an explicit id also verifies current source evidence.',
    since: 4,
    scope: 'plugin-private',
    capability: 'workspace:read',
    mutation: false,
    surfaces: ALL_SURFACES,
    params: z.strictObject({ id: id.optional() }).optional(),
    result: z.strictObject({ runs: z.array(PluginPipelineSummary).max(50) })
  }),
  'pipeline.pause': spec({
    summary:
      'An owner click pauses future stages of this plugin’s pipeline at the expected revision; active workers can still report.',
    since: 4,
    scope: 'plugin-private',
    capability: null,
    mutation: true,
    userActivation: true,
    surfaces: FRAMES_ONLY,
    params: PipelineControlParams,
    result: z.strictObject({ accepted: z.literal(true) })
  }),
  'pipeline.resume': spec({
    summary:
      'An owner click resumes this plugin’s paused pipeline after inspection; unknown effects remain fenced.',
    since: 4,
    scope: 'plugin-private',
    capability: null,
    mutation: true,
    userActivation: true,
    surfaces: FRAMES_ONLY,
    params: PipelineControlParams,
    result: z.strictObject({ accepted: z.literal(true) })
  })
}
