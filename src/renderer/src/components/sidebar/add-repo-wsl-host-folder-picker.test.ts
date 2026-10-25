import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wslDistroWindowsPathAccess } from '../../../../shared/windows-path-access'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { pickWslHostFolder, readDroppedHostPath } from './add-repo-wsl-host-folder-picker'

const access = wslDistroWindowsPathAccess('Ubuntu')

describe('pickWslHostFolder', () => {
  beforeEach(() => toastError.mockReset())

  it('opens at the host home and returns the Linux path of the pick', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('\\\\wsl.localhost\\ubuntu\\home\\me\\my repo')
    await expect(
      pickWslHostFolder(access, { readHome: async () => '/home/me', pickDirectory })
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
        pickDirectory
      })
    ).resolves.toBeNull()
    expect(pickDirectory).toHaveBeenCalledWith({ defaultPath: '\\\\wsl.localhost\\Ubuntu\\' })
  })

  it('accepts the legacy \\\\wsl$ spelling', async () => {
    await expect(
      pickWslHostFolder(access, {
        readHome: async () => '/home/me',
        pickDirectory: async () => '\\\\wsl$\\Ubuntu\\srv\\プロジェクト'
      })
    ).resolves.toBe('/srv/プロジェクト')
  })

  it('refuses a drive folder and says it stays on this computer', async () => {
    await expect(
      pickWslHostFolder(access, {
        readHome: async () => '/home/me',
        pickDirectory: async () => 'C:\\Users\\me\\src'
      })
    ).resolves.toBeNull()
    expect(toastError).toHaveBeenCalledWith('Pick a folder inside Ubuntu.', {
      description:
        'Folders on a Windows drive stay on this computer. Choose this computer as the host to add one.'
    })
  })

  it('refuses another distro by name', async () => {
    await expect(
      pickWslHostFolder(access, {
        readHome: async () => '/home/me',
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
