import { defineFixture } from '../../component-fixtures/component-fixture'
import SidebarHeader from './SidebarHeader'

export const Projects = defineFixture({
  width: 280,
  store: { sidebarBody: 'conversations' },
  render: () => <SidebarHeader onWorkspaceBoardMenuOpenChange={() => undefined} />
})

export const Workspaces = defineFixture({
  width: 280,
  store: { sidebarBody: 'workspaces' },
  render: () => <SidebarHeader onWorkspaceBoardMenuOpenChange={() => undefined} />
})
