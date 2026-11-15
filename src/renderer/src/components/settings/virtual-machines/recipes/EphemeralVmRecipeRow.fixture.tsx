import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { EphemeralVmRecipeRow } from './EphemeralVmRecipeRow'

const entry = { repoId: 'r', repoName: 'acme/web', repoPath: '/repo', recipes: [], diagnostics: [] }
const names = ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY']

function Rows() {
  return (
    <div className="divide-y divide-border/50 rounded-lg border border-border/50 bg-background text-foreground">
      <EphemeralVmRecipeRow
        entry={entry}
        recipe={{
          id: 'remote-vm',
          name: 'Remote VM',
          create: './scripts/vm/create.sh',
          destroy: './scripts/vm/destroy.sh'
        }}
        credentialEnvNames={names}
        onUse={() => {}}
      />
      <EphemeralVmRecipeRow
        entry={entry}
        recipe={{
          id: 'limited-vm',
          name: 'Limited VM',
          create: './scripts/vm/create.sh',
          destroy: './scripts/vm/destroy.sh',
          passEnv: ['GITHUB_TOKEN']
        }}
        credentialEnvNames={names}
        onUse={() => {}}
      />
      <EphemeralVmRecipeRow
        entry={entry}
        recipe={{
          id: 'ssh-vm',
          name: 'SSH host',
          create: './scripts/vm/ssh.sh',
          destroyDisabled: true,
          passEnv: []
        }}
        credentialEnvNames={names}
        onUse={() => {}}
      />
    </div>
  )
}

export const rows = defineFixture({ width: 720, render: () => <Rows /> })
