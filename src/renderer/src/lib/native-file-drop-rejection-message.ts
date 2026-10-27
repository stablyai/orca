import { translate } from '@/i18n/i18n'
import {
  NATIVE_FILE_DROP_MAX_PATHS,
  type NativeFileDropRejectedPayload
} from '../../../shared/native-file-drop'
import { describeDropTempCopyFailure } from './drop-temp-copy-failure-copy'

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
