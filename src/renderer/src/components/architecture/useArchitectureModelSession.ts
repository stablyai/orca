import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArchitectureWorkspace } from '../../../../shared/types'
import type { ArchitectureViewError } from '../../../../shared/scryer/architecture-view'
import { joinPath } from '../../lib/path'
import { hasRecentArchitectureSelfWrite } from './architecture-self-write-registry'
import { architectureViewToDiagramModel } from './architecture-view-model'
import type { ArchitectureDiagramModel } from './architecture-diagram-types'

export type ArchitectureProjectModelEntry = {
  name: string
  fileName: string
  path: string
  isDefault: boolean
  scope: 'project' | 'global'
}

export type ArchitectureTemplateEntry = {
  id: string
  name: string
}

export type ArchitectureViewDocument = {
  model: ArchitectureDiagramModel
  revision: string
}

function emptyDiagramModel(projectPath: string): ArchitectureDiagramModel {
  return {
    nodes: [],
    links: [],
    startingLevel: 'system',
    sourceMap: {},
    boundaries: {},
    projectPath,
    refPositions: {},
    groups: []
  }
}

export function sanitizeClientModelName(modelName?: string | null): string {
  const raw = (modelName ?? 'model').trim().replace(/\.scry$/i, '')
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || 'model'
}

export function isActiveArchitectureModelChange(
  fileName: string,
  activeModelName: string
): boolean {
  const activeName = sanitizeClientModelName(activeModelName)
  return (
    fileName === `${activeName}.scry` || (activeName === 'model' && fileName === 'planned.scry')
  )
}

function isCommittedArchitectureModelChange(fileName: string, activeModelName: string): boolean {
  return fileName === `${sanitizeClientModelName(activeModelName)}.scry`
}

function architectureViewErrorFields(error: ArchitectureViewError): string[] {
  const detailFields = error.details?.fields
  if (Array.isArray(detailFields)) {
    return detailFields.filter((field): field is string => typeof field === 'string')
  }
  return error.fieldErrors?.map((fieldError) => fieldError.path).filter(Boolean) ?? []
}

export function formatArchitectureViewError(error: ArchitectureViewError): string {
  if (error.code === 'incompatible_model' && error.details?.reason === 'unknown_fields') {
    const fields = architectureViewErrorFields(error)
    return fields.length
      ? `Scryer model contains unsupported fields: ${fields.join(', ')}`
      : 'Scryer model contains unsupported fields'
  }
  return error.message
}

export function useArchitectureModelSession({
  workspace,
  projectPath,
  setArchitectureModelRef,
  isActiveModelEditableTarget,
  onActiveModelReload,
  onActiveModelRemoved,
  onError
}: {
  workspace: ArchitectureWorkspace
  projectPath: string
  setArchitectureModelRef: (workspaceId: string, modelRef: string) => void
  isActiveModelEditableTarget: () => boolean
  onActiveModelReload: () => void
  onActiveModelRemoved: (
    removedModelName: string,
    knownModels: ArchitectureProjectModelEntry[]
  ) => void
  onError: (error: unknown) => void
}) {
  const activeModelNameRef = useRef(sanitizeClientModelName(workspace.modelRef))
  const [activeModelName, setActiveModelName] = useState(() =>
    sanitizeClientModelName(workspace.modelRef)
  )
  const [projectModels, setProjectModels] = useState<ArchitectureProjectModelEntry[]>([])
  const [templates, setTemplates] = useState<ArchitectureTemplateEntry[]>([])

  const refreshProjectModels = useCallback(async () => {
    if (!projectPath) {
      setProjectModels([])
      setTemplates([])
      return
    }
    const [models, nextTemplates] = await Promise.all([
      window.api.architecture.listModels({ projectPath }),
      window.api.architecture.listTemplates()
    ])
    setProjectModels(models)
    setTemplates(nextTemplates)
  }, [projectPath])

  const readArchitectureViewDocument = useCallback(
    async (requestedModelName?: string | null): Promise<ArchitectureViewDocument> => {
      const modelName = sanitizeClientModelName(requestedModelName ?? activeModelNameRef.current)
      if (modelName !== 'model') {
        throw new Error('Only the default Scryer 0.3 Architecture model is supported.')
      }
      const result = await window.api.architecture.readArchitectureView({
        projectPath,
        layer: 'plan'
      })
      if (!result.ok) {
        if (
          result.error.code === 'incompatible_model' &&
          result.error.message.includes('Missing Scryer model file')
        ) {
          return {
            model: emptyDiagramModel(projectPath),
            revision: result.requestId
          }
        }
        throw new Error(formatArchitectureViewError(result.error))
      }
      return {
        model: architectureViewToDiagramModel(result.result, projectPath),
        revision: result.requestId
      }
    },
    [projectPath]
  )

  const acceptLoadedArchitectureViewDocument = useCallback(
    (modelName: string, _revision: string) => {
      const sanitized = sanitizeClientModelName(modelName)
      activeModelNameRef.current = sanitized
      setActiveModelName(sanitized)
      setArchitectureModelRef(workspace.id, sanitized)
    },
    [setArchitectureModelRef, workspace.id]
  )

  const flushPendingArchitectureViewWork = useCallback(async () => {}, [])

  useEffect(() => {
    if (!projectPath) {
      return
    }
    void window.api.architecture.watchModel({ projectPath })
    return window.api.architecture.onModelChanged((event) => {
      if (event.projectPath !== projectPath) {
        return
      }
      const changedPath = joinPath(joinPath(event.projectPath, '.scryer'), event.fileName)
      if (hasRecentArchitectureSelfWrite(changedPath)) {
        return
      }
      if (!isActiveArchitectureModelChange(event.fileName, activeModelNameRef.current)) {
        void refreshProjectModels()
        return
      }
      void (async () => {
        if (!isCommittedArchitectureModelChange(event.fileName, activeModelNameRef.current)) {
          void refreshProjectModels()
          if (!isActiveModelEditableTarget()) {
            onActiveModelReload()
          }
          return
        }
        const remaining = await window.api.architecture.listModels({ projectPath })
        if (!remaining.some((entry) => entry.fileName === event.fileName)) {
          setProjectModels(remaining)
          onActiveModelRemoved(activeModelNameRef.current, remaining)
          return
        }
        setProjectModels(remaining)
        if (isActiveModelEditableTarget()) {
          return
        }
        onActiveModelReload()
      })().catch(onError)
    })
  }, [
    isActiveModelEditableTarget,
    onActiveModelReload,
    onActiveModelRemoved,
    onError,
    projectPath,
    refreshProjectModels
  ])

  return {
    activeModelName,
    activeModelNameRef,
    projectModels,
    templates,
    readArchitectureViewDocument,
    acceptLoadedArchitectureViewDocument,
    refreshProjectModels,
    flushPendingArchitectureViewWork
  }
}
