import { defineFixture } from '../../component-fixtures/component-fixture'
import { parseTaskQuery } from '../../../../shared/work-items/task-query'
import type { SectionKey } from '@/components/github/PRFilterSections'
import { TaskFilterMenu } from './TaskFilterMenu'

const labelOpts = ['bug', 'backend', 'needs review'].map((name) => ({ key: name, primary: name }))

function Menu({ sections }: { sections?: readonly SectionKey[] }): React.JSX.Element {
  return (
    <div className="bg-background p-2 pb-64">
      <TaskFilterMenu
        parsed={{ ...parseTaskQuery(''), labels: ['bug'] }}
        kind="prs"
        open
        onOpenChange={() => {}}
        sections={sections}
        labelOpts={labelOpts}
        labelsLoading={false}
        labelsError={null}
        onChange={() => {}}
      />
    </div>
  )
}

export const allSections = defineFixture({ width: 720, render: () => <Menu /> })
export const labelPicker = defineFixture({
  width: 720,
  render: () => <Menu sections={['label']} />,
  interact: () => {
    for (const button of document.body.querySelectorAll('button')) {
      if (button.textContent?.trim().startsWith('Label')) {
        button.click()
        return
      }
    }
  }
})
