import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wslDistroWindowsPathAccess } from '../../../../shared/windows-path-access'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { pickWslHostFolder, readDroppedHostPath } from './add-repo-wsl-host-folder-picker'

const access = wslDistroWindowsPathAccess('Ubuntu')
const onWindowsDriveRefusal = vi.fn()

describe('pickWslHostFolder', () => {
  beforeEach(() => {
    toastError.mockReset()
    onWindowsDriveRefusal.mockReset()
  })

  it('opens at the host home and returns the Linux path of the pick', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('\\\\wsl.localhost\\ubuntu\\home\\me\\my repo')
    await expect(
      pickWslHostFolder(access, {
        readHome: async () => '/home/me',
        pickDirectory,
        onWindowsDriveRefusal
      })
    ).resolves.toBe('/home/me/my repo')
    expect(pickDirectory).toHaveBeenCalledWith({
      defaultPath: '\\\\wsl.localhost\\Ubuntu\\home\\me'
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('opens at the distro root when the host cannot say where home is', async () => {
    const pickDirectory = vi.fn().mockResolvedValue(null)
    await expect(
      pickWslHostFolder(access, {
        readHome: () => Promise.reject(new Error('offline')),
        pickDirectory,
        onWindowsDriveRefusal
      })
    ).resolves.toBeNull()
    expect(pickDirectory).toHaveBeenCalledWith({ defaultPath: '\\\\wsl.localhost\\Ubuntu\\' })
  })

  it('accepts the legacy \\\\wsl$ spelling', async () => {
    await expect(
      pickWslHostFolder(access, {
        readHome: async () => '/home/me',
        onWindowsDriveRefusal,
        pickDirectory: async () => '\\\\wsl$\\Ubuntu\\srv\\プロジェクト'
      })
    ).resolves.toBe('/srv/プロジェクト')
  })

  it.each([
    ['a drive folder', 'C:\\Users\\me\\src', 'C:\\Users\\me\\src'],
    ['its drvfs mount', '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\src', 'C:\\Users\\me\\src'],
    ['another distro drvfs mount', '\\\\wsl$\\Debian\\mnt\\d\\work', 'D:\\work'],
    [
      'a long-path drvfs mount in another distro',
      '\\\\?\\UNC\\wsl.localhost\\Debian\\mnt\\d\\work',
      'D:\\work'
    ]
  ])('hands %s to the dialog as a Windows drive refusal', async (_name, picked, windowsPath) => {
    await expect(
      pickWslHostFolder(access, {
        readHome: async () => '/home/me',
        onWindowsDriveRefusal,
        pickDirectory: async () => picked
      })
    ).resolves.toBeNull()
    expect(onWindowsDriveRefusal).toHaveBeenCalledWith({
      kind: 'wsl_host_windows_drive_path',
      windowsPath
    })
    // Inline in the dialog: a toast above it could not take the click.
    expect(toastError).not.toHaveBeenCalled()
  })

  it('refuses another distro by name', async () => {
    await expect(
      pickWslHostFolder(access, {
        readHome: async () => '/home/me',
        onWindowsDriveRefusal,
        pickDirectory: async () => '\\\\wsl.localhost\\Debian\\home\\me'
      })
    ).resolves.toBeNull()
    expect(toastError).toHaveBeenCalledWith('That folder is in Debian, not Ubuntu.', {
      description: 'This host can only add folders under \\\\wsl.localhost\\Ubuntu.'
    })
  })
})

describe('readDroppedHostPath', () => {
  it('reads a well-formed drop and ignores anything else', () => {
    expect(
      readDroppedHostPath({
        droppedHostPath: { hostId: 'runtime:wsl%3AUbuntu', path: '/home/me' }
      })
    ).toEqual({ hostId: 'runtime:wsl%3AUbuntu', path: '/home/me' })
    expect(readDroppedHostPath({})).toBeNull()
    expect(readDroppedHostPath({ droppedHostPath: { hostId: 'bogus', path: '/x' } })).toBeNull()
    expect(
      readDroppedHostPath({ droppedHostPath: { hostId: 'runtime:wsl%3AUbuntu', path: '' } })
    ).toBeNull()
  })
})
