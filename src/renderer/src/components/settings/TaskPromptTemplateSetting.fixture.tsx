import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { TaskPromptTemplateSetting } from './TaskPromptTemplateSetting'

function PromptSettingFixture({
  scope,
  initialValue
}: {
  scope: 'global' | 'project'
  initialValue?: string
}): React.JSX.Element {
  const [value, setValue] = useState(
    initialValue ?? (scope === 'global' ? '{{url}} /jira-engineer' : '')
  )
  return (
    <TaskPromptTemplateSetting
      scope={scope}
      value={value}
      commit={async (next) => {
        setValue(next)
        return true
      }}
      globalTemplate="{{url}} /jira-engineer"
    />
  )
}

export const global = defineFixture({
  width: 680,
  render: () => <PromptSettingFixture scope="global" />
})

export const project = defineFixture({
  width: 680,
  render: () => <PromptSettingFixture scope="project" />
})

export const saveError = defineFixture({
  width: 680,
  render: () => (
    <TaskPromptTemplateSetting
      scope="project"
      value="{{url}} /project-skill"
      commit={async () => false}
    />
  ),
  interact: (frame) => frame.querySelector('button')?.click()
})

export const saved = defineFixture({
  width: 680,
  render: () => <PromptSettingFixture scope="project" initialValue="{{url}} /project-skill" />,
  interact: (frame) => frame.querySelector('button')?.click()
})
