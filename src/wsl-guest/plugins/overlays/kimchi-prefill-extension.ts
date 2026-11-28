import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PiAgentKind } from '../../../shared/agent-launch/catalog/pi-agent-kind'

const KIMCHI_PREFILL_EXTENSION_FILE = 'orca-prefill.ts'
const ORCA_MANAGED_EXTENSION_MARKER = '@orca-managed-pi-extension'

export class KimchiPrefillExtension {
  private source: string | null = null

  setSource(source: string | undefined): void {
    if (typeof source === 'string') {
      this.source = source.includes(ORCA_MANAGED_EXTENSION_MARKER)
        ? source
        : `// ${ORCA_MANAGED_EXTENSION_MARKER}\n${source}`
    }
  }

  write(extensionsDir: string, kind: PiAgentKind): void {
    if (kind !== 'kimchi' || !this.source) {
      return
    }
    const path = join(extensionsDir, KIMCHI_PREFILL_EXTENSION_FILE)
    let installed: string | undefined
    try {
      installed = readFileSync(path, 'utf8')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        return
      }
    }
    if (installed !== undefined && !installed.includes(ORCA_MANAGED_EXTENSION_MARKER)) {
      return
    }
    try {
      writeFileSync(path, this.source)
    } catch {
      // Status installation remains usable when a separate prefill write fails.
    }
  }
}
