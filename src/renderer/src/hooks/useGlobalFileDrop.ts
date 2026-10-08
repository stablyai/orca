import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_FILE_DROP_MAX_PATHS,
  type NativeFileDropRejectedPayload
} from '../../../shared/native-file-drop'
import { describeDropTempCopyFailure } from '@/lib/drop-temp-copy-failure-copy'
import { captureEditorFileDropOpen } from '@/components/editor/editor-dropped-file-open'

export function useGlobalFileDrop(): void {
  useEffect(() => {
    return window.api.ui.onFileDrop((data) => {
      if (data.target === 'rejected') {
        showNativeFileDropRejection(data)
        return
      }

      if (data.target !== 'editor') {
        return
      }

      // Only unmarked chrome still uses the preload drop route.
      const activeWorktreeId = useAppStore.getState().activeWorktreeId
      if (!activeWorktreeId) {
        return
      }
      void captureEditorFileDropOpen({ worktreeId: activeWorktreeId })(data.paths)
    })
  }, [])
}

function showNativeFileDropRejection(data: NativeFileDropRejectedPayload): void {
  const message = getNativeFileDropRejectionMessage(data)
  toast.error(message.title, { description: message.description })
}

export function getNativeFileDropRejectionMessage(data: NativeFileDropRejectedPayload): {
  description: string
  title: string
} {
  if (data.reason === 'temp-copy-failed') {
    return {
      description: describeDropTempCopyFailure(data.commonReason),
      title: translate(
        'auto.hooks.useGlobalFileDrop.nativeDropTempCopyFailed',
        "Orca couldn't copy {{count}} dropped files.",
        { count: data.pathCount }
      )
    }
  }

  if (data.reason === 'unresolved-paths') {
    return {
      description: translate(
        'auto.hooks.useGlobalFileDrop.nativeDropUnresolvedPathsDescription',
        'Save them to disk first, then drop the saved files.'
      ),
      title: translate(
        'auto.hooks.useGlobalFileDrop.nativeDropUnresolvedPaths',
        "Orca couldn't read a path for the dropped files."
      )
    }
  }

  if (data.reason === 'too-many-paths') {
    return {
      description: translate(
        'auto.hooks.useGlobalFileDrop.nativeDropTooManyPathsDescription',
        'Drop {{value0}} or fewer files at a time.',
        { value0: NATIVE_FILE_DROP_MAX_PATHS }
      ),
      title: translate(
        'auto.hooks.useGlobalFileDrop.nativeDropTooManyPaths',
        'Drop contains too many files.'
      )
    }
  }

  return {
    description: translate(
      'auto.hooks.useGlobalFileDrop.nativeDropPathsTooLargeDescription',
      'Drop fewer files or use a shorter path list.'
    ),
    title: translate(
      'auto.hooks.useGlobalFileDrop.nativeDropPathsTooLarge',
      'Drop path list is too large.'
    )
  }
}
