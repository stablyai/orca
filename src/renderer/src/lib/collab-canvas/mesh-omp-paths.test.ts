import { describe, expect, it } from 'vitest'
import {
  meshOmpCodingConfigPath,
  meshOmpSessionRoot,
  resolveMeshOwnerHome
} from './mesh-omp-paths'

describe('mesh-omp-paths (quoted argv must be absolute)', () => {
  it('expands to an absolute home, never a $HOME prefix', () => {
    const home = resolveMeshOwnerHome()
    expect(home.startsWith('/')).toBe(true)
    expect(home).not.toContain('$HOME')
    expect(meshOmpCodingConfigPath()).toBe(`${home}/meshina/configs/omp/mesh-coding.yml`)
    expect(meshOmpSessionRoot()).toBe(`${home}/.local/state/meshina/omp-sessions`)
  })

  it('config path exists on this mesh host', () => {
    // Live path the operator's pet spawn must open — fail closed if missing.
    const fs = require('node:fs') as typeof import('node:fs')
    expect(fs.existsSync(meshOmpCodingConfigPath())).toBe(true)
  })
})
