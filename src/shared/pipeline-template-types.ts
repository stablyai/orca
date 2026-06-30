import type { PipelineStageName } from './pipelines-types'

export type PipelineTaskSourceKind = 'github_issues'

export type PipelineTemplateSummary = {
  id: string
  name: string
  description: string
  version: number
  maxIterationsDefault: number
  maxConcurrentDefault: number
}

export type PipelineStageDefinition = {
  stage: PipelineStageName
  description: string
}

export type PipelinePromptSource =
  | {
      type: 'template'
      text: string
    }
  | {
      type: 'inline'
      text: string
    }

export type PipelinePromptDefinition = {
  id: string
  stage: PipelineStageName
  source: PipelinePromptSource
  acceptsArgs: boolean
}

export type PipelineStructuredOutputDefinition = {
  tag: 'plan'
  version: 1
}

export type PipelineTemplateSafetyPolicy = {
  dynamicContextTimeoutMs: number
  maxStdoutChars: number
  maxStderrChars: number
  strictUnusedArgs: boolean
}

export type PipelineTemplate = {
  id: string
  name: string
  description: string
  version: number
  maxIterationsDefault: number
  maxConcurrentDefault: number
  stages: PipelineStageDefinition[]
  prompts: {
    planner: PipelinePromptDefinition
    implementer: PipelinePromptDefinition
    reviewer?: PipelinePromptDefinition
    merger: PipelinePromptDefinition
    verifier?: PipelinePromptDefinition
  }
  plannerOutput: PipelineStructuredOutputDefinition
  taskSourceKinds: PipelineTaskSourceKind[]
  safety: PipelineTemplateSafetyPolicy
}

export type PipelinePlannerOutputV1 = {
  issues: {
    id: string
    title: string
    branch: string
    blockedBy?: string[]
  }[]
}
