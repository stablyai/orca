import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import {
  setExternalRecoveryBuffer,
  removeExternalRecoveryBuffer,
  retireExternalRecoveryBuffer,
  type ExternalRecoveryBuffer
} from '@/lib/editor-recovery-external-buffers'
import { getDiskBaselineSignature } from '../../diff-content-signature'
import type { DiffSection } from '../../diff-section-types'
import { flushPendingEditorChange } from '../../editor-pending-flush'

type CapturedSection = {
  parent: OpenFile
  baseline: string | undefined
  buffer: ExternalRecoveryBuffer
}

export function useCombinedDiffDraftRecovery(
  file: OpenFile,
  sections: readonly DiffSection[]
): {
  onDraftChange: (section: DiffSection, content: string) => void
  retireSection: (key: string, savedContent: string) => Promise<void>
} {
  const [instanceId] = useState(createBrowserUuid)
  const captured = useRef(new Map<string, CapturedSection>())
  const sectionId = useCallback(
    (key: string) => `combined-draft:${file.id}:${instanceId}:${key}`,
    [file.id, instanceId]
  )
  const onDraftChange = useCallback(
    (section: DiffSection, content: string): void => {
      const id = sectionId(section.key)
      const baseline =
        section.diffResult?.kind === 'text' ? section.diffResult.modifiedContent : undefined
      if (file.readOnly || section.area !== 'unstaged' || content === baseline) {
        removeExternalRecoveryBuffer(id)
        captured.current.delete(section.key)
        return
      }
      const previous = captured.current.get(section.key)
      if (previous && previous.buffer.file.id !== id) {
        removeExternalRecoveryBuffer(previous.buffer.file.id)
      }
      const recoveryFile =
        previous?.parent === file &&
        previous.baseline === baseline &&
        previous.buffer.file.relativePath === section.path
          ? previous.buffer.file
          : {
              id,
              filePath: joinPath(file.filePath, section.path),
              relativePath: section.path,
              worktreeId: file.worktreeId,
              language: detectLanguage(section.path),
              mode: 'diff' as const,
              diffSource: 'unstaged' as const,
              isDirty: true,
              runtimeEnvironmentId: file.runtimeEnvironmentId,
              externalSshTargetId: file.externalSshTargetId,
              operationProvenance: file.operationProvenance,
              lastKnownDiskSignature:
                baseline === undefined
                  ? undefined
                  : previous?.baseline === baseline
                    ? previous.buffer.file.lastKnownDiskSignature
                    : getDiskBaselineSignature(baseline)
            }
      const buffer = { file: recoveryFile, content }
      captured.current.set(section.key, { parent: file, baseline, buffer })
      setExternalRecoveryBuffer(buffer)
    },
    [file, sectionId]
  )

  useLayoutEffect(() => {
    const present = new Set<string>()
    for (const section of sections) {
      if (section.dirty && section.area === 'unstaged') {
        present.add(section.key)
        onDraftChange(section, section.modifiedContent)
      }
    }
    for (const [key, entry] of captured.current) {
      if (!present.has(key)) {
        removeExternalRecoveryBuffer(entry.buffer.file.id)
        captured.current.delete(key)
      }
    }
  }, [sections, onDraftChange])
  useLayoutEffect(() => {
    const entries = captured.current
    return () => {
      flushPendingEditorChange(file.id)
      for (const entry of entries.values()) {
        removeExternalRecoveryBuffer(entry.buffer.file.id)
      }
      entries.clear()
    }
  }, [file.id])

  return {
    onDraftChange,
    retireSection: useCallback(
      (key, savedContent) => retireExternalRecoveryBuffer(sectionId(key), savedContent),
      [sectionId]
    )
  }
}
