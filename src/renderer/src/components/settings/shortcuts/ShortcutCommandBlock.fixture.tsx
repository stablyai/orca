import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getKeybindingDefinition } from '../../../../../shared/keybindings/definitions'
import { ShortcutRowsList } from './ShortcutRowsList'

function NavigationShortcuts({ platform }: { platform: 'darwin' | 'win32' }): React.JSX.Element {
  const rows = (['editor.navigateBack', 'editor.navigateForward'] as const).map((id) => {
    const item = getKeybindingDefinition(id)
    if (!item) {
      throw new Error(`Missing navigation shortcut: ${id}`)
    }
    return {
      item,
      groupTitle: 'Editors',
      effective: [...item.defaultBindings[platform]],
      modified: false,
      warnings: []
    }
  })

  return (
    <ShortcutRowsList
      groups={[{ title: 'Editors', rows }]}
      platform={platform}
      errors={{}}
      disableMemory={{}}
      recordingActionId={null}
      recordingBindingIndex={null}
      onStartRecordingAt={() => {}}
      onAppendBinding={() => {}}
      onCancelRecording={() => {}}
      onCapture={() => {}}
      onClearError={() => {}}
      onRemoveBindingAt={() => {}}
      onResetAction={() => {}}
      onDisableAction={() => {}}
      onEnableAction={() => {}}
    />
  )
}

export const macOS = defineFixture({
  width: 640,
  render: () => <NavigationShortcuts platform="darwin" />
})

export const windows = defineFixture({
  width: 640,
  render: () => <NavigationShortcuts platform="win32" />
})
