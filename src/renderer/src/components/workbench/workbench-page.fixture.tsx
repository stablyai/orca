import { defineFixture } from '../../component-fixtures/component-fixture'
import WorkbenchPage from './workbench-page'

export const defaultView = defineFixture({
  width: 1024,
  render: () => (
    <div className="h-[640px]">
      <WorkbenchPage />
    </div>
  )
})
