import { useEffect } from 'react'
import * as monaco from 'monaco-editor'
import { useAppStore } from '@/store'
import {
  registerPythonDefinitionProvider,
  type PythonDefinitionHost,
  type PythonDefinitionTarget,
  type PythonDefinitionWorkspace
} from '@/lib/monaco-languages/python-definition-provider'

let providerRegistered = false

function workspaceOf(filePath: string): PythonDefinitionWorkspace | null {
  const entry = (useAppStore.getState().openFiles ?? []).find((file) => file.filePath === filePath)
  if (!entry?.relativePath || !filePath.endsWith(entry.relativePath)) {
    return null
  }
  const rootPath = filePath
    .slice(0, filePath.length - entry.relativePath.length)
    .replace(/\/+$/, '')
  return {
    worktreeId: entry.worktreeId,
    runtimeEnvironmentId: entry.runtimeEnvironmentId ?? null,
    rootPath
  }
}

const host: PythonDefinitionHost = {
  searchFiles: (options) => window.api.fs.search(options),
  readFile: async (filePath) => (await window.api.fs.readFile({ filePath })).content,
  pathExists: async (filePath) => {
    try {
      return await window.api.fs.pathExists({ filePath })
    } catch {
      return false
    }
  },
  resolveWorkspace: workspaceOf,
  openAndReveal: (target: PythonDefinitionTarget, workspace: PythonDefinitionWorkspace) => {
    const relativePath = target.filePath.slice(workspace.rootPath.length + 1)
    useAppStore.getState().openFile(
      {
        filePath: target.filePath,
        relativePath,
        worktreeId: workspace.worktreeId,
        runtimeEnvironmentId: workspace.runtimeEnvironmentId,
        language: 'python',
        mode: 'edit'
      },
      {
        suppressActiveRuntimeFallback: workspace.runtimeEnvironmentId === null,
        focusEditor: true
      }
    )
    // Wait two frames for the tab and its Monaco instance to mount before revealing the line.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        useAppStore.getState().setPendingEditorReveal({
          filePath: target.filePath,
          line: target.line,
          column: target.column,
          matchLength: 0
        })
      })
    })
  }
}

/** Register the python definition provider once; every editor then resolves symbols through it. */
export function useMonacoPythonDefinitions(): void {
  useEffect(() => {
    if (providerRegistered) {
      return
    }
    providerRegistered = true
    registerPythonDefinitionProvider(monaco, host)
  }, [])
}
