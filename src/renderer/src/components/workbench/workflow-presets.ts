import { create } from 'zustand'

export type WorkflowNodeKind = 'analyze' | 'implement' | 'verify' | 'accept' | 'commit' | 'cli'
export type WorkflowCliShell = 'auto' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'wsl'

export type WorkflowNodeDef = {
  id: string
  kind: WorkflowNodeKind
  labelKey?: string
  defaultLabel: string
  descriptionKey?: string
  defaultDescription: string
  instruction?: string
  shell?: WorkflowCliShell
  agent?: string
  model?: string
}

export type WorkflowPreset = {
  id: string
  custom?: boolean
  filePath?: string
  nameKey?: string
  defaultName: string
  descriptionKey?: string
  defaultDescription: string
  nodes: readonly WorkflowNodeDef[]
}

const HIDDEN_PRESETS_STORAGE_KEY = 'orca.workbench.hiddenPresets.v1'

function loadHiddenPresetIds(): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_PRESETS_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function saveHiddenPresetIds(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(HIDDEN_PRESETS_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Ignore storage quota errors.
  }
}

type WorkflowSelectionState = {
  selectedWorkflowId: string
  refreshToken: number
  hiddenPresetIds: string[]
  targetRepoId: string | null
  targetDir: string | null
  setSelectedWorkflowId: (id: string) => void
  triggerWorkflowRefresh: () => void
  hidePreset: (id: string) => void
  restoreHiddenPresets: () => void
  setTarget: (target: { repoId: string | null; dirPath: string | null }) => void
}

export const useWorkflowSelectionStore = create<WorkflowSelectionState>((set) => ({
  selectedWorkflowId: 'dev-e2e',
  refreshToken: 0,
  hiddenPresetIds: loadHiddenPresetIds(),
  targetRepoId: null,
  targetDir: null,
  setSelectedWorkflowId: (id) => set({ selectedWorkflowId: id }),
  triggerWorkflowRefresh: () => set((s) => ({ refreshToken: s.refreshToken + 1 })),
  hidePreset: (id) =>
    set((s) => {
      if (s.hiddenPresetIds.includes(id)) {
        return s
      }
      const next = [...s.hiddenPresetIds, id]
      saveHiddenPresetIds(next)
      return { hiddenPresetIds: next }
    }),
  restoreHiddenPresets: () => {
    saveHiddenPresetIds([])
    set({ hiddenPresetIds: [] })
  },
  setTarget: ({ repoId, dirPath }) =>
    set((s) => ({ targetRepoId: repoId, targetDir: dirPath, refreshToken: s.refreshToken + 1 }))
}))

export function resolvePresetLabel(
  p: WorkflowPreset,
  t: (key: string, defaultValue: string) => string
): string {
  return p.nameKey ? t(p.nameKey, p.defaultName) : p.defaultName
}

export function resolvePresetDescription(
  p: WorkflowPreset,
  t: (key: string, defaultValue: string) => string
): string {
  return p.descriptionKey ? t(p.descriptionKey, p.defaultDescription) : p.defaultDescription
}

export function resolveNodeLabel(
  n: WorkflowNodeDef,
  t: (key: string, defaultValue: string) => string
): string {
  return n.labelKey ? t(n.labelKey, n.defaultLabel) : n.defaultLabel
}

export function resolveNodeDescription(
  n: WorkflowNodeDef,
  t: (key: string, defaultValue: string) => string
): string {
  return n.descriptionKey ? t(n.descriptionKey, n.defaultDescription) : n.defaultDescription
}

export const WORKFLOW_PRESETS: readonly WorkflowPreset[] = [
  {
    id: 'dev-e2e',
    nameKey: 'auto.components.workbench.presets.devE2e.name',
    defaultName: 'Full Dev Pipeline',
    descriptionKey: 'auto.components.workbench.presets.devE2e.desc',
    defaultDescription: 'Analyze → Implement → Run CI → Fix CI → Code Review → Commit.',
    nodes: [
      {
        id: 'analyze',
        kind: 'analyze',
        labelKey: 'auto.components.workbench.nodes.analyze',
        defaultLabel: 'Analyze',
        descriptionKey: 'auto.components.workbench.nodes.analyzeDesc',
        defaultDescription: 'Break down requirement and locate target files'
      },
      {
        id: 'implement',
        kind: 'implement',
        labelKey: 'auto.components.workbench.nodes.implement',
        defaultLabel: 'Implement',
        descriptionKey: 'auto.components.workbench.nodes.implementDesc',
        defaultDescription: 'Write code changes in isolated worktree'
      },
      {
        id: 'ci',
        kind: 'verify',
        labelKey: 'auto.components.workbench.nodes.ci',
        defaultLabel: 'Run CI',
        descriptionKey: 'auto.components.workbench.nodes.ciDesc',
        defaultDescription: 'Run lint, typecheck, and changed tests'
      },
      {
        id: 'fix-ci',
        kind: 'implement',
        labelKey: 'auto.components.workbench.nodes.fixCi',
        defaultLabel: 'Fix CI',
        descriptionKey: 'auto.components.workbench.nodes.fixCiDesc',
        defaultDescription: 'Fix any CI failures until all checks pass'
      },
      {
        id: 'review',
        kind: 'accept',
        labelKey: 'auto.components.workbench.nodes.review',
        defaultLabel: 'Code Review',
        descriptionKey: 'auto.components.workbench.nodes.reviewDesc',
        defaultDescription: 'Review diff quality, edge cases, and maintainability'
      },
      {
        id: 'commit',
        kind: 'commit',
        labelKey: 'auto.components.workbench.nodes.commit',
        defaultLabel: 'Commit',
        descriptionKey: 'auto.components.workbench.nodes.commitDesc',
        defaultDescription: 'Stage verified changes and create a clean commit'
      }
    ]
  },
  {
    id: 'standard',
    nameKey: 'auto.components.workbench.presets.standard.name',
    defaultName: 'Standard Feature Flow',
    descriptionKey: 'auto.components.workbench.presets.standard.desc',
    defaultDescription:
      'Analyze requirement, implement in worktree, run checks, and verify acceptance.',
    nodes: [
      {
        id: 'analyze',
        kind: 'analyze',
        labelKey: 'auto.components.workbench.nodes.analyze',
        defaultLabel: 'Analyze',
        descriptionKey: 'auto.components.workbench.nodes.analyzeDesc',
        defaultDescription: 'Break down requirement and locate target files'
      },
      {
        id: 'implement',
        kind: 'implement',
        labelKey: 'auto.components.workbench.nodes.implement',
        defaultLabel: 'Implement',
        descriptionKey: 'auto.components.workbench.nodes.implementDesc',
        defaultDescription: 'Write code changes in isolated worktree'
      },
      {
        id: 'verify',
        kind: 'verify',
        labelKey: 'auto.components.workbench.nodes.verify',
        defaultLabel: 'Verify',
        descriptionKey: 'auto.components.workbench.nodes.verifyDesc',
        defaultDescription: 'Run lint, typecheck, and affected tests'
      },
      {
        id: 'accept',
        kind: 'accept',
        labelKey: 'auto.components.workbench.nodes.accept',
        defaultLabel: 'Accept',
        descriptionKey: 'auto.components.workbench.nodes.acceptDesc',
        defaultDescription: 'Final review and acceptance confirmation'
      }
    ]
  },
  {
    id: 'bugfix',
    nameKey: 'auto.components.workbench.presets.bugfix.name',
    defaultName: 'Bugfix Flow',
    descriptionKey: 'auto.components.workbench.presets.bugfix.desc',
    defaultDescription:
      'Reproduce root cause, apply minimal fix, run regression checks, and accept.',
    nodes: [
      {
        id: 'locate',
        kind: 'analyze',
        labelKey: 'auto.components.workbench.nodes.locate',
        defaultLabel: 'Locate Root Cause',
        descriptionKey: 'auto.components.workbench.nodes.locateDesc',
        defaultDescription: 'Trace failure path and reproduce issue'
      },
      {
        id: 'fix',
        kind: 'implement',
        labelKey: 'auto.components.workbench.nodes.fix',
        defaultLabel: 'Apply Fix',
        descriptionKey: 'auto.components.workbench.nodes.fixDesc',
        defaultDescription: 'Patch root cause with minimal diff'
      },
      {
        id: 'regression',
        kind: 'verify',
        labelKey: 'auto.components.workbench.nodes.regression',
        defaultLabel: 'Regression Check',
        descriptionKey: 'auto.components.workbench.nodes.regressionDesc',
        defaultDescription: 'Verify fix and ensure no regressions'
      },
      {
        id: 'accept',
        kind: 'accept',
        labelKey: 'auto.components.workbench.nodes.accept',
        defaultLabel: 'Accept',
        descriptionKey: 'auto.components.workbench.nodes.acceptDesc',
        defaultDescription: 'Final review and acceptance confirmation'
      }
    ]
  },
  {
    id: 'refactor',
    nameKey: 'auto.components.workbench.presets.refactor.name',
    defaultName: 'Refactor Flow',
    descriptionKey: 'auto.components.workbench.presets.refactor.desc',
    defaultDescription: 'Assess structure, refactor cleanly, verify types/tests, and accept.',
    nodes: [
      {
        id: 'assess',
        kind: 'analyze',
        labelKey: 'auto.components.workbench.nodes.assess',
        defaultLabel: 'Assess Structure',
        descriptionKey: 'auto.components.workbench.nodes.assessDesc',
        defaultDescription: 'Inspect boundaries and plan clean refactor'
      },
      {
        id: 'refactor',
        kind: 'implement',
        labelKey: 'auto.components.workbench.nodes.refactor',
        defaultLabel: 'Refactor',
        descriptionKey: 'auto.components.workbench.nodes.refactorDesc',
        defaultDescription: 'Apply modular refactoring'
      },
      {
        id: 'verify',
        kind: 'verify',
        labelKey: 'auto.components.workbench.nodes.verify',
        defaultLabel: 'Verify',
        descriptionKey: 'auto.components.workbench.nodes.verifyDesc',
        defaultDescription: 'Run lint, typecheck, and affected tests'
      },
      {
        id: 'accept',
        kind: 'accept',
        labelKey: 'auto.components.workbench.nodes.accept',
        defaultLabel: 'Accept',
        descriptionKey: 'auto.components.workbench.nodes.acceptDesc',
        defaultDescription: 'Final review and acceptance confirmation'
      }
    ]
  }
]
