import { useCallback, useMemo, useState } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import {
  createRuntimePath,
  readRuntimeFileContent,
  runtimePathExists,
  writeRuntimeFile
} from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import {
  getRuntimeGitignoreTemplate,
  listRuntimeGitignoreTemplates
} from '@/runtime/runtime-gitignore-template-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { GitignoreTemplateDialog } from './gitignore-template-dialog'

type GitignoreTemplateFlowOptions = RuntimeFileOperationArgs & {
  worktreeId: string
  worktreePath: string
}

export function useGitignoreTemplateFlow(options: GitignoreTemplateFlowOptions): {
  openGitignoreTemplateDialog(): Promise<void>
  dialog: React.JSX.Element
} {
  const [open, setOpen] = useState(false)
  const [existingContent, setExistingContent] = useState<string | null>(null)
  const openFile = useAppStore((state) => state.openFile)
  const filePath = joinPath(options.worktreePath, '.gitignore')
  const operationContext = useMemo<RuntimeFileOperationArgs>(
    () => ({
      settings: options.settings,
      worktreeId: options.worktreeId,
      worktreePath: options.worktreePath,
      connectionId: options.connectionId,
      expectedExecutionHostId: options.expectedExecutionHostId,
      expectedSshTargetId: options.expectedSshTargetId,
      expectedSshConnectionGeneration: options.expectedSshConnectionGeneration
    }),
    [
      options.connectionId,
      options.expectedExecutionHostId,
      options.expectedSshConnectionGeneration,
      options.expectedSshTargetId,
      options.settings,
      options.worktreeId,
      options.worktreePath
    ]
  )

  const revealFile = useCallback(() => {
    openFile({
      filePath,
      relativePath: '.gitignore',
      worktreeId: options.worktreeId,
      language: detectLanguage('.gitignore'),
      mode: 'edit'
    })
  }, [filePath, openFile, options.worktreeId])

  const openGitignoreTemplateDialog = useCallback(async () => {
    const exists = await runtimePathExists(operationContext, filePath)
    if (exists) {
      const result = await readRuntimeFileContent({
        settings: options.settings,
        filePath,
        relativePath: '.gitignore',
        worktreeId: options.worktreeId,
        connectionId: options.connectionId
      })
      setExistingContent(result.content)
      revealFile()
    } else {
      setExistingContent(null)
    }
    setOpen(true)
  }, [
    filePath,
    operationContext,
    options.connectionId,
    options.settings,
    options.worktreeId,
    revealFile
  ])

  const confirm = useCallback(
    async (content: string, mode: 'create' | 'append') => {
      const exists = await runtimePathExists(operationContext, filePath)
      if (mode === 'create' && exists) {
        revealFile()
        throw new Error('.gitignore was created while the preview was open. Review it before appending.')
      }
      if (mode === 'append') {
        if (!exists) {
          throw new Error('.gitignore was removed while the preview was open. Reopen the template picker.')
        }
        const latest = await readRuntimeFileContent({
          settings: options.settings,
          filePath,
          relativePath: '.gitignore',
          worktreeId: options.worktreeId,
          connectionId: options.connectionId
        })
        if (latest.content !== existingContent) {
          revealFile()
          throw new Error('.gitignore changed while the preview was open. Review the latest file and try again.')
        }
      }
      if (mode === 'create') {
        await createRuntimePath(operationContext, filePath, 'file')
      }
      await writeRuntimeFile(operationContext, filePath, content)
      revealFile()
    },
    [
      existingContent,
      filePath,
      operationContext,
      options.connectionId,
      options.settings,
      options.worktreeId,
      revealFile
    ]
  )
  const listTemplates = useCallback(
    () => listRuntimeGitignoreTemplates(options.settings),
    [options.settings]
  )
  const getTemplate = useCallback(
    (name: string) => getRuntimeGitignoreTemplate(options.settings, name),
    [options.settings]
  )

  return {
    openGitignoreTemplateDialog,
    dialog: (
      <GitignoreTemplateDialog
        open={open}
        existingContent={existingContent}
        onOpenChange={setOpen}
        listTemplates={listTemplates}
        getTemplate={getTemplate}
        onConfirm={confirm}
      />
    )
  }
}
