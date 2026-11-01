import { describe, expect, it } from 'vitest'
import { blockedPluginSaveAsExtension } from './plugin-save-as-extensions'

describe('files.saveAs blocked extensions', () => {
  it.each([
    ['setup.exe', 'exe'],
    ['Run.BAT', 'bat'],
    ['tool.ps1', 'ps1'],
    ['link.lnk', 'lnk'],
    ['site.webloc', 'webloc'],
    ['Installer.pkg', 'pkg'],
    ['run.command', 'command'],
    ['start.sh', 'sh'],
    ['app.desktop', 'desktop'],
    ['trick.exe. . ', 'exe'],
    ['/Users/me/Downloads/payload.js', 'js']
  ])('refuses %s', (name, extension) => {
    expect(blockedPluginSaveAsExtension(name)).toBe(extension)
  })

  it.each(['scene.excalidraw', 'chart.png', 'data.json', 'notes', '.bashrc', 'archive.tar.gz'])(
    'allows %s',
    (name) => {
      expect(blockedPluginSaveAsExtension(name)).toBeNull()
    }
  )
})
