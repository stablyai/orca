import { describe, expect, it } from 'vitest'
import { Files } from 'lucide-react'
import type { ActivityBarItem } from './activity-bar-buttons'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'

const items: ActivityBarItem[] = [
  { id: 'explorer', icon: Files, title: 'Explorer', shortcut: '' },
  {
    id: 'workspaces',
    icon: Files,
    title: 'Workspaces',
    shortcut: '',
    folderOnly: true
  },
  {
    id: 'pr-checks',
    icon: Files,
    title: 'PR Checks',
    shortcut: '',
    folderOnly: true
  },
  {
    id: 'source-control',
    icon: Files,
    title: 'Source Control',
    shortcut: '',
    gitOnly: true,
    folderWorkspaceAllowed: true
  },
  {
    id: 'checks',
    icon: Files,
    title: 'Checks',
    shortcut: '',
    gitOnly: true
  },
  { id: 'ports', icon: Files, title: 'Ports', shortcut: '', sshOnly: true }
]

describe('getVisibleRightSidebarActivityItems', () => {
  it('shows ports only for SSH repos', () => {
    expect(
      getVisibleRightSidebarActivityItems(items, {
        isFolder: false,
        isFolderWorkspace: false,
        isSshRepo: false
      }).map((item) => item.id)
    ).toEqual(['explorer', 'source-control', 'checks'])

    expect(
      getVisibleRightSidebarActivityItems(items, {
        isFolder: false,
        isFolderWorkspace: false,
        isSshRepo: true
      }).map((item) => item.id)
    ).toEqual(['explorer', 'source-control', 'checks', 'ports'])
  })

  it('shows folder-workspace-safe Source Control for folder workspaces', () => {
    expect(
      getVisibleRightSidebarActivityItems(items, {
        isFolder: true,
        isFolderWorkspace: true,
        isSshRepo: true
      }).map((item) => item.id)
    ).toEqual(['explorer', 'workspaces', 'pr-checks', 'source-control', 'ports'])
  })

  it('hides git tabs for plain non-git folders', () => {
    expect(
      getVisibleRightSidebarActivityItems(items, {
        isFolder: true,
        isFolderWorkspace: false,
        isSshRepo: true
      }).map((item) => item.id)
    ).toEqual(['explorer', 'ports'])
  })
})
