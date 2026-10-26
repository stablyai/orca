import * as yaml from 'yaml'
import { parseOrcaYamlWithParser } from './orca-yaml-parser'
import type { OrcaHooks } from './orca-yaml-hook-types'

export { ORCA_VM_RECIPE_ID_PATTERN, ORCA_VM_RECIPE_ID_RULE } from './orca-yaml-parser'

export function parseOrcaYaml(content: string): OrcaHooks | null {
  return parseOrcaYamlWithParser(content, yaml)
}
