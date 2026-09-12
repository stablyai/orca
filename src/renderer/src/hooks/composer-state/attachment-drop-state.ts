import type { ComposerModel } from './composer-model'

type AttachmentDropStateInput = Pick<
  ComposerModel,
  | 'agentPromptRef'
  | 'cancelPromptCaretFrame'
  | 'connectionId'
  | 'promptCaretFrameRef'
  | 'promptTextareaRef'
  | 'selectedRepoPath'
  | 'selectedRepoSettings'
  | 'setAgentPrompt'
  | 'setAttachmentPaths'
>

import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { joinPath } from '@/lib/path'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { useAppStore } from '@/store'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import {
  collectComposerDropUploadResult,
  shouldReportComposerDropUploadFailure
} from '../composer-drop-upload-result'
import { applyComposerNativeFileDrop } from '../composer-native-file-drop'
import { useComposerDropListener } from './composer-drop-listener'

export function useAttachmentDropState(input: AttachmentDropStateInput) {
  const {
    agentPromptRef,
    cancelPromptCaretFrame,
    connectionId,
    promptCaretFrameRef,
    promptTextareaRef,
    selectedRepoPath,
    selectedRepoSettings,
    setAgentPrompt,
    setAttachmentPaths
  } = input

  const addComposerAttachments = useCallback(
    (paths: string[]): void => {
      if (paths.length === 0) {
        return
      }
      setAttachmentPaths((current) => {
        const next = [...current]
        for (const pathValue of paths) {
          if (!next.includes(pathValue)) {
            next.push(pathValue)
          }
        }
        return next
      })
    },
    [setAttachmentPaths]
  )

  const insertComposerFolderPaths = useCallback(
    (folderPaths: string[]): void => {
      if (folderPaths.length === 0) {
        return
      }
      // Why: de-dup within one drop — the OS can deliver the same folder twice when the selection includes an item and its parent.
      const uniqueFolderPaths = Array.from(new Set(folderPaths))
      // Why: quote paths with shell metacharacters so an inserted folder ref stays one token if pasted into a terminal; simple paths stay unadorned.
      const formatPath = (p: string): string => {
        if (/[\s"'$`\\()[\]{}*?!;&|<>#~]/.test(p)) {
          return `"${p.replace(/(["\\$`])/g, '\\$1')}"`
        }
        return p
      }
      const insertion = uniqueFolderPaths.map(formatPath).join(' ')
      const textarea = promptTextareaRef.current
      // Why: compute selection/insertion/caret outside the setAgentPrompt updater so it stays pure — Strict Mode double-invokes updaters in dev.
      const current = agentPromptRef.current
      const selStart = textarea?.selectionStart ?? current.length
      const selEnd = textarea?.selectionEnd ?? current.length
      const before = current.slice(0, selStart)
      const after = current.slice(selEnd)
      // Why: pad with spaces when the caret abuts text so the folder path doesn't merge into an adjacent word.
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
      const needsTrailingSpace = after.length > 0 && !/^\s/.test(after)
      const padded = `${needsLeadingSpace ? ' ' : ''}${insertion}${needsTrailingSpace ? ' ' : ''}`
      const caret = before.length + padded.length
      if (textarea) {
        cancelPromptCaretFrame()
        promptCaretFrameRef.current = requestAnimationFrame(() => {
          promptCaretFrameRef.current = null
          if (promptTextareaRef.current !== textarea || !textarea.isConnected) {
            return
          }
          textarea.focus()
          textarea.setSelectionRange(caret, caret)
        })
      }
      // Why: pass a plain value (not an updater) since before/after were already resolved, keeping the write pure under Strict-Mode double-render.
      setAgentPrompt(before + padded + after)
    },
    [cancelPromptCaretFrame, agentPromptRef, promptCaretFrameRef, promptTextareaRef, setAgentPrompt]
  )

  const uploadComposerPaths = useCallback(
    async (
      sourcePaths: string[],
      targetSettings = selectedRepoSettings,
      targetConnectionId: string | null | undefined = connectionId,
      targetRepoPath: string | null | undefined = selectedRepoPath,
      canReportFailure: () => boolean = () => true
    ): Promise<{ filePaths: string[]; folderPaths: string[] } | null> => {
      if (!targetSettings?.activeRuntimeEnvironmentId?.trim() && !targetConnectionId) {
        return null
      }
      if (!targetRepoPath) {
        if (canReportFailure()) {
          toast.error(
            translate(
              'auto.hooks.useComposerState.3db83fc58a',
              'No project path is available on this host for attachments.'
            )
          )
        }
        return { filePaths: [], folderPaths: [] }
      }
      const destinationDir = joinPath(targetRepoPath, '.orca/drops')
      const sshExpectation = targetConnectionId
        ? captureDirectSshMutationExpectation(
            useAppStore.getState(),
            targetConnectionId,
            targetSettings?.activeRuntimeEnvironmentId
          )
        : {
            expectedExecutionHostId: 'local' as const,
            expectedSshTargetId: undefined,
            expectedSshConnectionGeneration: undefined
          }
      const assertCurrent = targetConnectionId
        ? () => {
            const current = captureDirectSshMutationExpectation(
              useAppStore.getState(),
              targetConnectionId,
              targetSettings?.activeRuntimeEnvironmentId
            )
            if (
              current.expectedSshTargetId !== sshExpectation.expectedSshTargetId ||
              current.expectedSshConnectionGeneration !==
                sshExpectation.expectedSshConnectionGeneration
            ) {
              throw new Error('Attachment upload host changed; retry the upload.')
            }
          }
        : undefined
      const { results } = await importExternalPathsToRuntime(
        {
          settings: targetSettings,
          worktreeId: targetRepoPath,
          worktreePath: targetRepoPath,
          connectionId: targetConnectionId ?? undefined,
          ...sshExpectation
        },
        sourcePaths,
        destinationDir,
        { ensureDestinationDir: true, assertCurrent }
      )
      const uploadResult = collectComposerDropUploadResult(results)
      if (shouldReportComposerDropUploadFailure(uploadResult, canReportFailure)) {
        toast.error(
          translate(
            'auto.hooks.useComposerState.a9ff236145',
            'Some attachments could not be uploaded.'
          )
        )
      }
      return { filePaths: uploadResult.filePaths, folderPaths: uploadResult.folderPaths }
    },
    [connectionId, selectedRepoPath, selectedRepoSettings]
  )

  const handleAddAttachment = useCallback(async (): Promise<void> => {
    try {
      const selectedPath = await window.api.shell.pickAttachment()
      if (!selectedPath) {
        return
      }
      const uploaded = await uploadComposerPaths([selectedPath])
      if (uploaded) {
        addComposerAttachments(uploaded.filePaths)
        insertComposerFolderPaths(uploaded.folderPaths)
        return
      }
      addComposerAttachments([selectedPath])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add attachment.'
      toast.error(message)
    }
  }, [addComposerAttachments, insertComposerFolderPaths, uploadComposerPaths])

  const applyLocalComposerDrop = useCallback(
    async (paths: string[], canApply: () => boolean = () => true): Promise<void> => {
      const fileAttachments: string[] = []
      const folderPaths: string[] = []
      for (const filePath of paths) {
        try {
          await window.api.fs.authorizeExternalPath({ targetPath: filePath })
          const stat = await window.api.fs.stat({ filePath })
          if (stat.isDirectory) {
            folderPaths.push(filePath)
          } else {
            fileAttachments.push(filePath)
          }
        } catch {
          // Skip paths we cannot authorize or stat.
        }
      }

      if (!canApply()) {
        return
      }
      addComposerAttachments(fileAttachments)
      insertComposerFolderPaths(folderPaths)
    },
    [addComposerAttachments, insertComposerFolderPaths]
  )

  const applyNativeDrop = useCallback(
    (paths: string[], isCurrentOwner: () => boolean): void => {
      void applyComposerNativeFileDrop({
        paths,
        isCurrentOwner,
        uploadPaths: (sourcePaths) =>
          uploadComposerPaths(
            sourcePaths,
            selectedRepoSettings,
            connectionId,
            selectedRepoPath,
            isCurrentOwner
          ),
        applyLocalPaths: applyLocalComposerDrop,
        addAttachments: addComposerAttachments,
        insertFolderPaths: insertComposerFolderPaths,
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : 'Failed to drop files.')
      })
    },
    [
      addComposerAttachments,
      applyLocalComposerDrop,
      connectionId,
      insertComposerFolderPaths,
      selectedRepoPath,
      selectedRepoSettings,
      uploadComposerPaths
    ]
  )
  // Why: native OS file drops relay via the preload bridge; only the most recently mounted composer applies them.
  useComposerDropListener(applyNativeDrop)

  return {
    addComposerAttachments,
    insertComposerFolderPaths,
    uploadComposerPaths,
    handleAddAttachment,
    applyLocalComposerDrop
  }
}
