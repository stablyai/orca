import { defineFixture } from '../../component-fixtures/component-fixture'
import { BotToolEditor } from './BotToolEditor'
import type { BotToolDetails } from '../../../../shared/bot-tools'

const context = {
  agent: 'codex' as const,
  platform: 'darwin' as const,
  folder: '/preview/.orca/bots/atlas'
}
const saved: BotToolDetails = {
  version: 'a'.repeat(64),
  server: {
    name: 'release-docs',
    url: 'https://docs.example/mcp',
    transport: 'http',
    headers: [{ key: 'Authorization', configured: true }]
  }
}
function Frame({ edit = false }: { edit?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card p-6 text-card-foreground">
      <h1 className="mb-2 text-lg font-semibold">{edit ? 'Edit tool' : 'Add a tool'}</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Only Atlas gets it, in addition to your own tools.
      </p>
      <BotToolEditor
        context={context}
        host={null}
        saved={edit ? saved : undefined}
        taken={new Set(['existing'])}
        onSave={async () => {}}
        onCancel={() => {}}
      />
    </div>
  )
}
export const pasteFirst = defineFixture({ width: 520, render: () => <Frame /> })
export const savedDetails = defineFixture({ width: 520, render: () => <Frame edit /> })
export const narrowSavedDetails = defineFixture({ width: 390, render: () => <Frame edit /> })
