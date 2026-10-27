import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { AgentCatalogRow } from './AgentCatalogRow'

function CatalogFixture(): React.JSX.Element {
  useTranslation()
  const [isDefault, setDefault] = useState(false)
  return (
    <div className="divide-y divide-border bg-background p-4 text-foreground">
      {(['claude', 'codex', 'antigravity'] as const).map((agentId, index) => (
        <AgentCatalogRow
          key={agentId}
          agentId={agentId}
          label={['Claude', 'Codex', 'Antigravity'][index]}
          homepageUrl="https://example.com"
          defaultCmd={agentId}
          defaultArgs=""
          defaultEnv={{}}
          argsOverride=""
          envOverride={{}}
          cmdOverride={undefined}
          isDetected
          isEnabled={index !== 2}
          isDefault={index === 1 ? !isDefault : isDefault}
          onSetDefault={() => setDefault((value) => !value)}
          onSetEnabled={() => {}}
          onSaveOverride={() => {}}
          onSaveArgs={() => {}}
          onSaveEnv={() => {}}
        />
      ))}
    </div>
  )
}

const fixture = (width: number) =>
  defineFixture({
    width,
    render: () => <CatalogFixture />,
    interact: async () => {
      await setRendererUiLanguage('fr')
    }
  })

export const wide = fixture(900)
export const narrow = fixture(480)
export const compact = fixture(320)
