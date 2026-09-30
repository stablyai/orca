import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { applyBackgroundActivationPolicy } from '../../../../src/main/window/foreground-activation-policy'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Spinner measurements require ORCA_BACKGROUND_LAUNCH=1')
}
app.setPath('userData', path.join(__dirname, 'profile'))
applyBackgroundActivationPolicy()
// Exercise the frame pipeline while keeping the native window hidden.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 850,
    webPreferences: { backgroundThrottling: false }
  })
  await window.loadURL('about:blank')
})
