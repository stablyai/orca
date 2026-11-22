import { usKeyboardUsageForKey } from '../../../../../shared/emulator/emulator-keyboard-frame'
import { ANDROID_KEY_BUTTONS, type ScrcpyKeyboard } from '../streaming/use-emulator-control-stream'

/**
 * Sends one Android pane key; false when it isn't a key the pane types. A key whose character a US
 * layout would type the same way goes to the hardware keyboard, where the device's own layout and
 * input methods see a real key. Anything else is typed as text, so no character comes out wrong.
 */
export function sendAndroidKey(
  keyboard: ScrcpyKeyboard,
  key: { code: string; key: string; shift: boolean; typesText: boolean }
): boolean {
  const button = ANDROID_KEY_BUTTONS[key.key]
  const usage = usKeyboardUsageForKey(key.code, key.key, key.shift)
  if (usage !== null) {
    keyboard.sendHidKey(
      button ? { usage, shift: key.shift, button } : { usage, shift: key.shift, text: key.key }
    )
  } else if (button) {
    keyboard.sendKey(button, key.shift)
  } else if (key.typesText) {
    void keyboard.sendText(key.key)
  } else {
    return false
  }
  return true
}
