import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { PipelinePicker, type PipelineChoice } from './PipelinePicker'

const profiles: PipelineChoice[] = [
  {
    id: 'local.task-pipelines/standard-development',
    version: '1',
    digest: 'a'.repeat(64),
    title: 'Development with independent review',
    profile: {
      id: 'standard-development',
      version: '1',
      title: 'Development with independent review',
      checks: ['test'],
      maxFixCycles: 2,
      roles: { primary: { agent: 'codex' }, reviewer: { agent: 'codex' } }
    }
  }
]
function Preview({ initial = '' }: { initial?: string }) {
  const [selected, setSelected] = useState(initial)
  return (
    <div className="bg-background text-foreground p-4">
      <PipelinePicker profiles={profiles} selected={selected} onSelect={setSelected} />
    </div>
  )
}
export const selected = defineFixture({
  width: 440,
  render: () => <Preview initial={profiles[0].id} />
})
export const narrow = defineFixture({
  width: 320,
  render: () => <Preview initial={profiles[0].id} />
})
export const none = defineFixture({ width: 440, render: () => <Preview /> })
