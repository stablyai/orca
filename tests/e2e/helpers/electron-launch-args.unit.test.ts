import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getMCodeElectronLaunchArgs } from './electron-launch-args'

describe('getMCodeElectronLaunchArgs', () => {
  it('launches the package root that owns the compiled main entry', () => {
    const root = join('workspace', 'mcode')
    const mainPath = join(root, 'out', 'main', 'index.js')

    expect(getMCodeElectronLaunchArgs(mainPath, true)).toEqual([root])
    expect(getMCodeElectronLaunchArgs(mainPath, false).at(-1)).toBe(root)
  })
})
