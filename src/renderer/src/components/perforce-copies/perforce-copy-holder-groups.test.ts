import { describe, expect, it } from 'vitest'
import type { WorkspaceCopyHolder } from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import {
  countedProgramNames,
  groupCopyHolders,
  heldFolderInCopy
} from './perforce-copy-holder-groups'

function holder(
  pid: number,
  name: string,
  parentPid: number | null,
  startedAt = pid
): WorkspaceCopyHolder {
  return { pid, name, commandLine: name, startedAt, parentPid }
}

describe('Perforce copy holder groups', () => {
  it('shows a shell once, with the agent and tools it started', () => {
    const shell = holder(20, 'cmd.exe', 1)
    const agent = holder(21, 'claude.exe', 20)
    const mcp = holder(22, 'node.exe', 21)
    const mcpChild = holder(23, 'node.exe', 22)
    const hub = holder(30, 'Unity Hub.exe', 1)
    const groups = groupCopyHolders([shell, agent, mcp, mcpChild, hub])
    expect(groups).toEqual([
      { holder: shell, started: [agent, mcp, mcpChild] },
      { holder: hub, started: [] }
    ])
    expect(countedProgramNames(groups[0].started)).toBe('claude.exe, node.exe ×2')
  })

  it('does not take a reused pid for a parent', () => {
    // pid 20 started after its supposed child, so the child's real parent exited.
    const groups = groupCopyHolders([
      holder(20, 'cmd.exe', 1, 500),
      holder(21, 'node.exe', 20, 100)
    ])
    expect(groups.map((group) => group.holder.pid)).toEqual([20, 21])
  })

  it('survives a parent cycle', () => {
    const groups = groupCopyHolders([holder(20, 'a.exe', 21, 1), holder(21, 'b.exe', 20, 1)])
    expect(groups.flatMap((group) => [group.holder, ...group.started])).toHaveLength(2)
  })

  it('names the held folder relative to the copy', () => {
    const at = (heldFolder: string | null): WorkspaceCopyHolder => ({
      ...holder(1, 'x.exe', null),
      heldFolder
    })
    expect(heldFolderInCopy(at('D:\\ws.wt\\one\\Game'), 'D:\\ws.wt\\one')).toBe('Game')
    expect(heldFolderInCopy(at('d:\\WS.wt\\one'), 'D:\\ws.wt\\one\\')).toBe('')
    expect(heldFolderInCopy(at(null), 'D:\\ws.wt\\one')).toBeNull()
  })
})
