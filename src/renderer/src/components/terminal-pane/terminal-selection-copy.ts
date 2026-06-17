export async function copyTerminalSelection(selection: string): Promise<boolean> {
  if (!selection) {
    return false
  }
  try {
    await window.api.ui.writeClipboardText(selection)
    const readback = await window.api.ui.readClipboardText()
    return readback === selection
  } catch {
    return false
  }
}
