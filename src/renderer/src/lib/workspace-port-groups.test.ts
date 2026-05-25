import { describe, expect, it } from 'vitest'
import {
  getExternalWorkspacePorts,
  getWorkspacePortGroups,
  getWorkspacePortsByWorktreeId
} from './workspace-port-groups'

describe('workspace port group caches', () => {
  it('returns stable empty references when no scan result exists', () => {
    expect(getWorkspacePortsByWorktreeId(null)).toBe(getWorkspacePortsByWorktreeId(undefined))
    expect(getWorkspacePortGroups(null)).toBe(getWorkspacePortGroups(undefined))
    expect(getExternalWorkspacePorts(null)).toBe(getExternalWorkspacePorts(undefined))
  })
})
