import { describe, expect, it } from 'vitest'
import {
  readWslHostWindowsDriveRefusal,
  WslHostWindowsDriveRefusalError,
  wslHostWindowsDriveRefusalForLinuxPath,
  wslHostWindowsDriveRefusalForPickedPath
} from './wsl-host-windows-drive-refusal'

describe('wslHostWindowsDriveRefusalForLinuxPath', () => {
  it.each([
    ['/mnt/c', 'C:\\'],
    ['/mnt/c/', 'C:\\'],
    ['  /mnt/d/src//app/  ', 'D:\\src\\app'],
    ['/mnt/C/x', 'C:\\x'],
    ['/home/me/../../mnt/e/./w', 'E:\\w']
  ])('refuses %j as %s', (linuxPath, windowsPath) => {
    expect(wslHostWindowsDriveRefusalForLinuxPath(linuxPath)).toEqual({
      kind: 'wsl_host_windows_drive_path',
      windowsPath
    })
  })

  it.each([
    '/home/me/src',
    '/mnt/cache/src',
    '/mnt/wslg',
    '/MNT/c/src',
    'C:\\src',
    '/mnt/c/../../home',
    'mnt/c/src'
  ])('leaves %j alone', (path) => {
    expect(wslHostWindowsDriveRefusalForLinuxPath(path)).toBeNull()
  })
})

describe('wslHostWindowsDriveRefusalForPickedPath', () => {
  it.each([
    ['C:\\Users\\me', 'C:\\Users\\me'],
    ['\\\\?\\D:\\work', 'D:\\work'],
    ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\src', 'C:\\src'],
    ['\\\\wsl$\\Debian\\mnt\\d', 'D:\\'],
    ['\\\\?\\UNC\\wsl.localhost\\Debian\\mnt\\d\\w', 'D:\\w']
  ])('refuses %j as %s', (picked, windowsPath) => {
    expect(wslHostWindowsDriveRefusalForPickedPath(picked)?.windowsPath).toBe(windowsPath)
  })

  it.each(['\\\\wsl.localhost\\Ubuntu\\home\\me', '\\\\server\\share\\x'])(
    'leaves %j alone',
    (picked) => {
      expect(wslHostWindowsDriveRefusalForPickedPath(picked)).toBeNull()
    }
  )
})

describe('readWslHostWindowsDriveRefusal', () => {
  it('reads the refusal the host sends and ignores other error data', () => {
    expect(
      readWslHostWindowsDriveRefusal(new WslHostWindowsDriveRefusalError('C:\\a').data)
    ).toEqual({ kind: 'wsl_host_windows_drive_path', windowsPath: 'C:\\a' })
    expect(
      readWslHostWindowsDriveRefusal({ kind: 'wsl_host_windows_drive_path', windowsPath: 7 })
    ).toEqual({ kind: 'wsl_host_windows_drive_path', windowsPath: null })
    expect(readWslHostWindowsDriveRefusal({ kind: 'other' })).toBeNull()
    expect(readWslHostWindowsDriveRefusal(undefined)).toBeNull()
  })

  it('reads plainly for clients that only show the message', () => {
    expect(new WslHostWindowsDriveRefusalError(null).message).toBe(
      'This folder is on a Windows drive. Add it on this computer instead: Git in WSL reports false line-ending changes there, misses edits made from Windows, and searches it slowly.'
    )
  })
})
