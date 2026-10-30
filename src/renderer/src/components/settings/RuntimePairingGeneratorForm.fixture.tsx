import { defineFixture } from '../../component-fixtures/component-fixture'
import { RuntimePairingGeneratorForm } from './RuntimePairingGeneratorForm'

export const relay = defineFixture({
  width: 540,
  render: () => (
    <div className="bg-background p-6 text-foreground">
      <RuntimePairingGeneratorForm
        intent="relay"
        loopbackAddress="127.0.0.1"
        networkInterfaces={[]}
        selectedAddress="127.0.0.1"
        refreshingNetworkInterfaces={false}
        isGeneratingPairing={false}
        webClientUrl={null}
        runtimePairingUrl={null}
        copiedTarget={null}
        generatedAddress={null}
        onIntentChange={() => {}}
        onSelectedAddressChange={() => {}}
        onRefreshNetworkInterfaces={() => {}}
        onGenerate={() => {}}
        onCopy={() => {}}
      />
    </div>
  )
})
