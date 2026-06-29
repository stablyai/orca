import { translate } from '@/i18n/i18n'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'
import { HeroFlow, HeroIntro, HeroPaired, type PairedDevice, type Platform } from './MobileHero'
import type { StepIndex } from './MobileHero'
import { getInstallCopy, type IosChannel } from './mobile-platform-copy'
import type { MobilePageStage } from './mobile-page-stage'
import { MobilePageToolbar } from './MobilePageToolbar'
import { PhoneCarousel } from './PhoneCarousel'

type MobilePageContentProps = {
  closeMobilePage: () => void
  copyInstallUrl: () => void
  copyPairingCode: () => void
  devices: PairedDevice[]
  enterFlow: () => void
  generatePairing: (rotate: boolean) => void
  handleAddressChange: (address: string) => void
  handleBack: () => void
  handleContinue: () => void
  installQrUrl: string | null
  iosChannel: IosChannel
  setIosChannel: (channel: IosChannel) => void
  loadNetworkInterfaces: () => void
  networkInterfaces: MobileNetworkInterface[]
  openInstallUrl: () => void
  pairAnotherDevice: () => void
  pairLoading: boolean
  pairQrDataUrl: string | null
  pairingUrl: string | null
  platform: Platform
  refreshingNetworkInterfaces: boolean
  revokeDevice: (id: string) => void
  revokingDeviceIds: string[]
  selectedAddress: string | undefined
  setPlatform: (platform: Platform) => void
  showMobileButton: boolean
  showPairedDevices: (deviceCount: number) => void
  stage: MobilePageStage | null
  stepIdx: StepIndex
  toggleMobileSidebarButton: () => void
}

export function MobilePageContent({
  closeMobilePage,
  copyInstallUrl,
  copyPairingCode,
  devices,
  enterFlow,
  generatePairing,
  handleAddressChange,
  handleBack,
  handleContinue,
  installQrUrl,
  iosChannel,
  setIosChannel,
  loadNetworkInterfaces,
  networkInterfaces,
  openInstallUrl,
  pairAnotherDevice,
  pairLoading,
  pairQrDataUrl,
  pairingUrl,
  platform,
  refreshingNetworkInterfaces,
  revokeDevice,
  revokingDeviceIds,
  selectedAddress,
  setPlatform,
  showMobileButton,
  showPairedDevices,
  stage,
  stepIdx,
  toggleMobileSidebarButton
}: MobilePageContentProps): React.JSX.Element {
  return (
    <div className="mobile-page-root">
      <MobilePageToolbar
        showMobileButton={showMobileButton}
        onClose={closeMobilePage}
        onToggleMobileSidebarButton={toggleMobileSidebarButton}
      />
      <section className="mp-hero">
        <div className="mp-hero-copy">
          {stage === null ? null : stage === 'intro' ? (
            <HeroIntro onStart={enterFlow} />
          ) : stage === 'paired' ? (
            <HeroPaired
              devices={devices}
              onPairAnother={pairAnotherDevice}
              onRevoke={(id) => revokeDevice(id)}
              revokingDeviceIds={revokingDeviceIds}
            />
          ) : (
            <HeroFlow
              stepIdx={stepIdx}
              platform={platform}
              onPlatformChange={setPlatform}
              installQrUrl={installQrUrl}
              installCopy={getInstallCopy(platform, iosChannel)}
              iosChannel={iosChannel}
              onIosChannelChange={setIosChannel}
              onOpenInstallUrl={openInstallUrl}
              onCopyInstallUrl={copyInstallUrl}
              pairQrDataUrl={pairQrDataUrl}
              pairingUrl={pairingUrl}
              pairLoading={pairLoading}
              onRegeneratePairing={() => generatePairing(true)}
              onCopyPairingCode={copyPairingCode}
              networkInterfaces={networkInterfaces}
              selectedAddress={selectedAddress}
              onSelectedAddressChange={handleAddressChange}
              onRefreshNetworkInterfaces={loadNetworkInterfaces}
              refreshingNetworkInterfaces={refreshingNetworkInterfaces}
              onBack={handleBack}
              onContinue={handleContinue}
              onDone={devices.length > 0 ? () => showPairedDevices(devices.length) : undefined}
            />
          )}
        </div>

        <div
          className="mp-stage"
          aria-label={translate('auto.components.mobile.MobilePage.e17393c6a3', 'Phone preview')}
        >
          <PhoneCarousel />
        </div>
      </section>
    </div>
  )
}
