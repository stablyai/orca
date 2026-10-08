import { useDialogRegistry } from './dialog-registry'
import { INITIAL_DIALOG_REGISTRY } from './dialog-registry-state'

/** @internal - tests start from an empty registry; `startupSettled` models a running app. */
export function resetDialogRegistryForTests(options: { startupSettled?: boolean } = {}): void {
  useDialogRegistry.setState({
    ...INITIAL_DIALOG_REGISTRY,
    ...(options.startupSettled
      ? {
          startupSources: {
            'crash-report': 'none',
            'feature-tip': 'none',
            'native-chat-resume': 'none'
          }
        }
      : {})
  })
}
