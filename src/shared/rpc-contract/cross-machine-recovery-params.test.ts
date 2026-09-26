import { describe, expect, it } from 'vitest'
import type { OrcaRecoveryDescriptorV1, RecoveryLayout } from '../cross-machine-recovery-descriptor'
import { sanitizeTerminalTabForRecovery } from '../cross-machine-recovery-session-projection'
import type { TabGroupLayoutNode } from '../tab-types'
import type { TerminalTab } from '../terminal-tab-types'
import {
  CrossMachineRecoveryImportParams,
  CrossMachineRecoveryPresentationPublishParams,
  OrcaRecoveryDescriptorV1Schema
} from './cross-machine-recovery-params'

const terminalTab: TerminalTab = {
  id: 'tab-1',
  ptyId: 'pty-9',
  worktreeId: 'repo::/src/wt',
  title: 'claude',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  generation: 4,
  shellOverride: 'zsh',
  forceHostRuntime: true,
  startupCwd: '/src/wt/pkg',
  pendingActivationSpawn: true
}

function layout(groupLayout: TabGroupLayoutNode | null = { type: 'leaf', groupId: 'g1' }) {
  return {
    tabs: [
      {
        id: 'tab-1',
        entityId: 'tab-1',
        groupId: 'g1',
        contentType: 'terminal',
        label: 'claude',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ],
    groups: [{ id: 'g1', activeTabId: 'tab-1', tabOrder: ['tab-1'] }],
    groupLayout,
    activeGroupId: 'g1',
    terminalTabs: [sanitizeTerminalTabForRecovery(terminalTab)],
    terminalLayouts: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    },
    startupCwdRelative: { 'tab-1': 'pkg' },
    editors: [],
    activeEditorRelativePath: null,
    browsers: [],
    activeBrowserId: null,
    activeTabType: 'terminal',
    activeTabId: 'tab-1'
  } satisfies RecoveryLayout
}

function descriptor(recoveryLayout: RecoveryLayout = layout()): OrcaRecoveryDescriptorV1 {
  return {
    version: 1,
    exportedAt: 10,
    source: {
      runtimeId: 'rt-1',
      appVersion: '1.4.212',
      machineName: 'Laptop',
      platform: 'darwin',
      executionHostId: 'local'
    },
    repo: { id: 'repo', path: '/src/repo', displayName: 'repo' },
    workspace: {
      worktreeId: 'repo::/src/wt',
      instanceId: 'inst-1',
      path: '/src/wt',
      branch: 'feature',
      meta: {
        displayName: 'feature',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        lastActivityAt: 5,
        isPinned: false
      }
    },
    layout: recoveryLayout,
    presentation: { views: [], preferredClientKey: null, freshness: 'host-only' },
    bindings: [
      {
        sourcePaneKey: 'tab-1:leaf-1',
        sourceTabId: 'tab-1',
        sourceLeafId: 'leaf-1',
        surface: 'terminal',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-1' },
        liveness: 'live',
        state: 'working',
        launch: { sourceAgentArgs: null, sourceEnvKeys: ['CLAUDE_CONFIG_DIR'] },
        capturedAt: 1,
        updatedAt: 2,
        lastHumanInputAt: null
      }
    ]
  }
}

function nestedGroupLayout(depth: number): TabGroupLayoutNode {
  let node: TabGroupLayoutNode = { type: 'leaf', groupId: 'g1' }
  for (let i = 0; i < depth; i += 1) {
    node = {
      type: 'split',
      direction: 'vertical',
      first: node,
      second: { type: 'leaf', groupId: 'g1' }
    }
  }
  return node
}

describe('cross-machine recovery contract', () => {
  it('strips host-only terminal fields for export', () => {
    expect(sanitizeTerminalTabForRecovery(terminalTab)).toEqual({
      id: 'tab-1',
      title: 'claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      startupCwd: '/src/wt/pkg'
    })
  })

  it('accepts a well-formed descriptor', () => {
    const value = descriptor()
    expect(OrcaRecoveryDescriptorV1Schema.parse(value)).toEqual(value)
  })

  it('rejects unknown descriptor fields and versions', () => {
    expect(OrcaRecoveryDescriptorV1Schema.safeParse({ ...descriptor(), extra: 1 }).success).toBe(
      false
    )
    expect(OrcaRecoveryDescriptorV1Schema.safeParse({ ...descriptor(), version: 2 }).success).toBe(
      false
    )
    const withPty = descriptor()
    const leaked = { ...withPty.layout, terminalTabs: [terminalTab] }
    expect(OrcaRecoveryDescriptorV1Schema.safeParse({ ...withPty, layout: leaked }).success).toBe(
      false
    )
  })

  it('bounds the tab group layout depth', () => {
    expect(
      OrcaRecoveryDescriptorV1Schema.safeParse(descriptor(layout(nestedGroupLayout(8)))).success
    ).toBe(true)
    expect(
      OrcaRecoveryDescriptorV1Schema.safeParse(descriptor(layout(nestedGroupLayout(200)))).success
    ).toBe(false)
  })

  it('leaves descriptor validation to the import handler', () => {
    const parsed = CrossMachineRecoveryImportParams.safeParse({
      descriptor: { version: 99 },
      checkoutPath: '/dst/wt',
      checkpointId: 'cp-1',
      resume: ['sess-1']
    })
    expect(parsed.success).toBe(true)
    expect(
      CrossMachineRecoveryImportParams.safeParse({
        descriptor: {},
        checkoutPath: '/dst/wt',
        checkpointId: 'cp-1',
        resume: ['-rf']
      }).success
    ).toBe(false)
  })

  it('validates presentation publishes', () => {
    const publish = {
      clientInstanceId: 'client-1',
      clientName: 'Desk',
      clientRevision: 3,
      workspaces: [
        {
          workspace: { kind: 'worktree', worktreeId: 'repo::/src/wt', instanceId: 'inst-1' },
          view: layout(),
          focus: {
            isActiveWorkspace: true,
            focusedTabId: 'tab-1',
            focusedLeafId: 'leaf-1',
            focusedPaneKey: 'tab-1:leaf-1',
            windowFocused: true
          },
          input: {
            msSinceHumanInput: 1000,
            msSinceHumanFocus: null,
            msSinceHumanInputByPaneKey: { 'tab-1:leaf-1': 1000 }
          }
        }
      ]
    }
    expect(CrossMachineRecoveryPresentationPublishParams.parse(publish)).toEqual(publish)
    expect(
      CrossMachineRecoveryPresentationPublishParams.safeParse({
        ...publish,
        workspaces: Array.from({ length: 65 }, () => publish.workspaces[0])
      }).success
    ).toBe(false)
  })
})
