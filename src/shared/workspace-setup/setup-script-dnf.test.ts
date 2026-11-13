import { describe, expect, it } from 'vitest'
import { dnfLinesIn, referencedScriptPaths, translateDnfInstalls } from './setup-script-dnf'
import { inspectConductorConfig } from './setup-script-import-conductor'

const APT = 'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y'

describe('PARITY-DNF: Amazon Linux install lines in an imported setup', () => {
  it('rewrites a plain dnf install where every package has a clear Ubuntu name', () => {
    const { setup, translated, unresolved } = translateDnfInstalls(
      'sudo dnf install -y gcc-c++ make python3-devel openssl-devel libffi-devel\npnpm install'
    )
    expect(setup).toBe(`${APT} g++ make python3-dev libssl-dev libffi-dev\npnpm install`)
    expect(translated).toBe(1)
    expect(unresolved).toEqual([])
  })

  it('translates each piece of a chained line and keeps the rest as written', () => {
    const { setup } = translateDnfInstalls(
      'yum -y install git jq && corepack enable && pnpm install --frozen-lockfile'
    )
    expect(setup).toBe(`${APT} git jq && corepack enable && pnpm install --frozen-lockfile`)
  })

  it('leaves an unknown or ambiguous package as written and lists it (never guesses)', () => {
    const line = 'sudo dnf install -y postgresql15 libpq-devel nodejs20'
    const { setup, translated, unresolved } = translateDnfInstalls(`${line}\nbun install`)
    expect(setup).toBe(`${line}\nbun install`)
    expect(translated).toBe(0)
    expect(unresolved).toEqual([line])
  })

  it('leaves non-install dnf commands, variables and unknown options for the person', () => {
    const { setup, unresolved } = translateDnfInstalls(
      'sudo dnf groupinstall -y "Development Tools"\nsudo dnf install -y $PACKAGES\ndnf install --enablerepo=epel jq\nsudo dnf update -y'
    )
    expect(setup).toContain('groupinstall')
    expect(unresolved).toHaveLength(4)
  })

  it('leaves a setup with no dnf untouched', () => {
    expect(translateDnfInstalls('sudo apt-get install -y jq\nnpm ci')).toEqual({
      setup: 'sudo apt-get install -y jq\nnpm ci',
      translated: 0,
      unresolved: []
    })
  })

  it('finds the script files a setup runs, and their dnf lines (read only)', () => {
    expect(referencedScriptPaths('./conductor-setup.sh')).toEqual(['conductor-setup.sh'])
    expect(referencedScriptPaths('bash scripts/setup.sh && pnpm dev')).toEqual(['scripts/setup.sh'])
    expect(referencedScriptPaths('bash /etc/setup.sh; sh ../up.sh')).toEqual([])
    expect(
      dnfLinesIn(
        '#!/bin/bash\n# dnf install comment\nset -e\nsudo dnf install -y postgresql15\ncurl -fsSL x | bash\nyum install -y jq'
      )
    ).toEqual(['sudo dnf install -y postgresql15', 'yum install -y jq'])
  })
})

describe('PARITY-DNF in the Conductor importer', () => {
  function reader(files: Record<string, string>) {
    return async (path: string): Promise<string | null> => files[path] ?? null
  }

  it('translates an inline setup and says so', async () => {
    const candidate = await inspectConductorConfig(
      reader({
        '.conductor/settings.toml':
          '[scripts]\nsetup = """\nsudo dnf install -y gcc-c++ make\npnpm install\n"""\n'
      })
    )
    expect(candidate?.setup).toContain(`${APT} g++ make`)
    expect(candidate?.ubuntuNote).toEqual({ translated: 1, checkLines: [] })
  })

  it('a script file that uses dnf is listed, never changed', async () => {
    const script = '#!/bin/bash\nset -e\nsudo dnf install -y postgresql15\nnpm ci\n'
    const candidate = await inspectConductorConfig(
      reader({
        'conductor.json': JSON.stringify({ scripts: { setup: './conductor-setup.sh' } }),
        'conductor-setup.sh': script
      })
    )
    expect(candidate?.setup).toBe('./conductor-setup.sh')
    expect(candidate?.ubuntuNote).toEqual({
      translated: 0,
      checkLines: ['conductor-setup.sh: sudo dnf install -y postgresql15']
    })
  })

  it('no dnf anywhere: no note', async () => {
    const candidate = await inspectConductorConfig(
      reader({ '.conductor/settings.toml': '[scripts]\nsetup = "pnpm install"\n' })
    )
    expect(candidate?.setup).toBe('pnpm install')
    expect(candidate?.ubuntuNote).toBeUndefined()
  })
})
