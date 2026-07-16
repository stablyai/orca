import { translate } from '@/i18n/i18n'

export function formatFileDeletionFailure(args: {
  name: string
  isRemote: boolean
  isWindows: boolean
}): string {
  // Why: the action and OS destination change sentence structure across
  // languages, so they cannot be injected as English verb fragments.
  if (args.isRemote) {
    return translate(
      'auto.components.right.sidebar.file.deletion.localized.copy.222a8a3fb3',
      "Failed to delete '{{value0}}'.",
      { value0: args.name }
    )
  }
  return args.isWindows
    ? translate(
        'auto.components.right.sidebar.file.deletion.localized.copy.e9605383fd',
        "Failed to move '{{value0}}' to the Recycle Bin.",
        { value0: args.name }
      )
    : translate(
        'auto.components.right.sidebar.file.deletion.localized.copy.f5fbc0837d',
        "Failed to move '{{value0}}' to the Trash.",
        { value0: args.name }
      )
}

export function formatMixedFileDeletionDescription(isWindows: boolean): string {
  // Why: Recycle Bin and Trash are localized product terms, not data values.
  return isWindows
    ? translate(
        'auto.components.right.sidebar.file.deletion.localized.copy.f583bf91df',
        'Remote items are permanently deleted and cannot be undone. Local items move to the Recycle Bin.'
      )
    : translate(
        'auto.components.right.sidebar.file.deletion.localized.copy.b1bde1b2e4',
        'Remote items are permanently deleted and cannot be undone. Local items move to the Trash.'
      )
}
