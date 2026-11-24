import { expect, it } from 'vitest'
import { pipelineRunResource } from '../../src/renderer/src/components/pipelines/pipeline-run-resource'
import {
  pipelineRetainedInputs,
  readPipelineRetainedInput,
  releasePipelineRetainedInput
} from '../../src/renderer/src/components/pipelines/pipeline-retained-inputs'

it('keeps all dirty inputs reachable and renders capacity instead of throwing on another run', () => {
  for (let index = 0; index < 16; index++) {
    const resource = pipelineRunResource({
      projectId: 'retained-project',
      workspaceInstanceId: `instance-${index}`,
      runId: `run-${index}`
    })
    resource.setText('comment', `Owner text ${index}`)
  }
  expect(() =>
    pipelineRunResource({
      projectId: 'new-project',
      workspaceInstanceId: 'new-instance',
      runId: 'new-run'
    })
  ).not.toThrow()
  const next = { projectId: 'new-project', workspaceInstanceId: 'new-instance', runId: 'new-run' }
  expect(pipelineRunResource(next).capacity).toBe(true)
  const entry = pipelineRetainedInputs().find((entry) => entry.runId === 'run-0')!
  expect(JSON.parse(readPipelineRetainedInput(entry.key))).toMatchObject({
    scope: { runId: 'run-0', workspaceInstanceId: 'instance-0' },
    comment: 'Owner text 0'
  })
  expect(() => releasePipelineRetainedInput(entry.key, false)).toThrow('closed_copy')
  expect(pipelineRunResource(next).capacity).toBe(true)
  releasePipelineRetainedInput(entry.key, true)
  expect(pipelineRunResource(next).capacity).toBe(false)
  expect(pipelineRetainedInputs().some((value) => value.runId === 'run-1')).toBe(true)
})
