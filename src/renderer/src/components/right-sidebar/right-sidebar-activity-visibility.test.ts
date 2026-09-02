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
    gitOnly: true
  },
  { id: 'ports', icon: Files, title: 'Ports', shortcut: '', sshOnly: true },
  // Plugin panels carry no visibility flags, so they show in every context.
  {
    id: 'plugin:orca-samples.my-plugin/dashboard',
    icon: Files,
    title: 'Dashboard',
    shortcut: ''
  }
]

describe('getVisibleRightSidebarActivityItems', () => {
  it('shows ports only for SSH repos', () => {
    expect(
      getVisibleRightSidebarActivityItems(items, {
        isFolder: false,
        isFolderWorkspace: false,
        isSshRepo: false
      }).map((item) => item.id)
    ).toEqual(['explorer', 'source-control', 'plugin:orca-samples.my-plugin/dashboard'])

    expect(
      getVisibleRightSidebarActivityItems(items, {
        isFolder: false,
        isFolderWorkspace: false,
        isSshRepo: true
      }).map((item) => item.id)
    ).toEqual(['explorer', 'source-control', 'ports', 'plugin:orca-samples.my-plugin/dashboard'])
  })

  it('shows Workspaces only for folder workspaces and hides git tabs for all folder scopes', () => {
    expect(
      getVisibleRightSidebarActivityItems(items, {
        isFolder: true,
        isFolderWorkspace: true,
        isSshRepo: true
      }).map((item) => item.id)
    ).toEqual([
      'explorer',
      'workspaces',
      'pr-checks',
      'ports',
      'plugin:orca-samples.my-plugin/dashboard'
    ])

    expect(
      getVisibleRightSidebarActivityItems(items, {
        isFolder: true,
        isFolderWorkspace: false,
        isSshRepo: true
      }).map((item) => item.id)
    ).toEqual(['explorer', 'ports', 'plugin:orca-samples.my-plugin/dashboard'])
  })
})
