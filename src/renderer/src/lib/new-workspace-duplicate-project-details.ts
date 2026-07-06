import { getExecutionHostLabel, type ExecutionHostId } from '../../../shared/execution-host'
import type { NewWorkspaceProjectOption } from './new-workspace-project-options'

export type ProjectSetupDirectory = {
  path: string
  hostId: ExecutionHostId
}

export type ProjectOptionDraft = Extract<NewWorkspaceProjectOption, { kind: 'project' }> & {
  detailSource: 'provider' | 'generic'
}

type ProjectDirectoryDetailMode = 'path' | 'host-label' | 'host-id'

function getRepeatedValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value)
      continue
    }
    seen.add(value)
  }
  return repeated
}

function getProjectDirectoryDetail(
  directories: readonly ProjectSetupDirectory[],
  hostLabelById: ReadonlyMap<ExecutionHostId, string>,
  mode: ProjectDirectoryDetailMode
): string | null {
  const detailByKey = new Map<string, string>()
  for (const directory of directories) {
    const path = directory.path.trim()
    if (!path) {
      continue
    }
    const hostLabel =
      hostLabelById.get(directory.hostId)?.trim() || getExecutionHostLabel(directory.hostId)
    const detail =
      mode === 'path'
        ? path
        : mode === 'host-id'
          ? `${hostLabel} (${directory.hostId}) · ${path}`
          : `${hostLabel} · ${path}`
    const key = mode === 'path' ? path : `${directory.hostId}\0${path}`
    detailByKey.set(key, detail)
  }

  const distinctDetails = [...detailByKey.values()].sort()
  if (distinctDetails.length === 0) {
    return null
  }

  const [firstDetail] = distinctDetails
  return distinctDetails.length === 1
    ? firstDetail
    : `${firstDetail} (+${distinctDetails.length - 1} more)`
}

export function getDuplicateProjectDetailsById(
  options: readonly ProjectOptionDraft[],
  setupDirectoriesByProjectId: ReadonlyMap<string, readonly ProjectSetupDirectory[]>,
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
): Map<string, string> {
  const optionsByName = new Map<string, ProjectOptionDraft[]>()
  for (const option of options) {
    optionsByName.set(option.displayName, [
      ...(optionsByName.get(option.displayName) ?? []),
      option
    ])
  }

  const detailsById = new Map<string, string>()
  for (const sameNameOptions of optionsByName.values()) {
    if (sameNameOptions.length < 2) {
      continue
    }

    const repeatedProviderDetails = getRepeatedValues(
      sameNameOptions
        .filter((option) => option.detailSource === 'provider')
        .map((option) => option.detail)
    )
    const ambiguousOptions = sameNameOptions.filter(
      (option) => option.detailSource === 'generic' || repeatedProviderDetails.has(option.detail)
    )
    if (ambiguousOptions.length === 0) {
      continue
    }

    const pathOnlyDetailsById = new Map<string, string>()
    for (const option of ambiguousOptions) {
      const detail = getProjectDirectoryDetail(
        setupDirectoriesByProjectId.get(option.projectId) ?? [],
        hostLabelById,
        'path'
      )
      if (detail) {
        pathOnlyDetailsById.set(option.id, detail)
      }
    }

    const repeatedPathOnlyDetails = getRepeatedValues([...pathOnlyDetailsById.values()])
    const hostLabelDetailsById = new Map<string, string>()
    for (const option of ambiguousOptions) {
      const pathOnlyDetail = pathOnlyDetailsById.get(option.id)
      if (!pathOnlyDetail || !repeatedPathOnlyDetails.has(pathOnlyDetail)) {
        continue
      }
      const detail = getProjectDirectoryDetail(
        setupDirectoriesByProjectId.get(option.projectId) ?? [],
        hostLabelById,
        'host-label'
      )
      if (detail) {
        hostLabelDetailsById.set(option.id, detail)
      }
    }

    const repeatedHostLabelDetails = getRepeatedValues([...hostLabelDetailsById.values()])
    for (const option of ambiguousOptions) {
      const pathOnlyDetail = pathOnlyDetailsById.get(option.id)
      if (!pathOnlyDetail) {
        continue
      }
      let detail = pathOnlyDetail
      if (repeatedPathOnlyDetails.has(pathOnlyDetail)) {
        detail = hostLabelDetailsById.get(option.id) ?? pathOnlyDetail
        if (repeatedHostLabelDetails.has(detail)) {
          // Why: user-renamed hosts can share a label, so fall back to the
          // stable host id only when the final visible detail still repeats.
          detail =
            getProjectDirectoryDetail(
              setupDirectoriesByProjectId.get(option.projectId) ?? [],
              hostLabelById,
              'host-id'
            ) ?? detail
        }
      }
      detailsById.set(option.id, detail)
    }
  }

  return detailsById
}
