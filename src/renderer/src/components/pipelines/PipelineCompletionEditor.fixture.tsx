import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { pipelineV2ReviewedFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { PipelineCompletionEditor } from './PipelineCompletionEditor'

function View() {
  const [template, setTemplate] = useState(() => {
    const value = pipelineV2ReviewedFixture()
    for (const stage of value.stages) {
      if (stage.kind === 'agent') {
        stage.independent = false
        stage.executor.session = { kind: 'reuse', groupId: 'primary' }
      }
    }
    if (value.completionPolicy.kind === 'reviewed_source') {
      value.completionPolicy.reviewRequirements[0] = {
        stageId: 'review',
        acceptedOutcomeIds: ['approved'],
        independent: false,
        freshSession: false
      }
      value.completionPolicy.findingPolicy = 'tracked'
    }
    return value
  })
  return (
    <div className="bg-background p-4 text-foreground">
      <PipelineCompletionEditor
        template={template}
        onChange={(patch) => setTemplate({ ...template, ...patch })}
      />
    </div>
  )
}

export const sharedReview = defineFixture({
  width: 680,
  render: () => <View />,
  interact: (frame) => {
    frame.querySelector<HTMLElement>('summary')?.click()
  }
})
