import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { AppearanceChatSection } from './AppearanceChatSection'

function Section(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  return settings ? (
    <AppearanceChatSection settings={settings} updateSettings={() => {}} forceVisiblePrimary />
  ) : null
}

export const chatUi = defineFixture({ width: 720, render: () => <Section /> })
