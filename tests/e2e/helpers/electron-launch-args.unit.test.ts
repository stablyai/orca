import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getOrcaElectronLaunchArgs } from './electron-launch-args'

describe('getOrcaElectronLaunchArgs', () => {
  it('launches the package root that owns the compiled main entry', () => {
    const root = join('workspace', 'orca')
    const mainPath = join(root, 'out', 'main', 'index.js')

    expect(getOrcaElectronLaunchArgs(mainPath, true)).toEqual([root])
    expect(getOrcaElectronLaunchArgs(mainPath, false).at(-1)).toBe(root)
  })
})
