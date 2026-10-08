import { useEffect, useRef, useState, type JSX } from 'react'
import { toast } from 'sonner'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { FEATURE_TIPS, type FeatureTipId } from '../../../../shared/feature-tips'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'
import { useAppStore } from '@/store'
import { CliSetupTipDialog } from './CliSetupTipDialog'
import { CmdJPaletteTipDialog } from './CmdJPaletteTipDialog'
import { installCliFromFeatureTip } from './feature-tip-cli-install-action'
import {
  trackCmdJPaletteFeatureTipAcknowledged,
  trackOrcaCliFeatureTipSetupClicked,
  trackOrcaCliFeatureTipSetupResult
} from './feature-tip-telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { SessionSearchTipDialog } from './SessionSearchTipDialog'
import { useSessionSearchTipSetup } from './use-session-search-tip-setup'
import { VoiceDictationTipDialog } from './VoiceDictationTipDialog'

/** The tip the app offers at launch, controlled by its host (AppOpenFeatureTip). */
export function FeatureTipDialogs({
  open: isOpen,
  tipId,
  onClose: closeModal
}: {
  open: boolean
  tipId: FeatureTipId
  onClose: () => void
}): JSX.Element | null {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const showAiVaultSearch = useAppStore((s) => s.showAiVaultSearch)
  const mountedRef = useMountedRef()
  const openRef = useRef(isOpen)
  const setupRequestIdRef = useRef(0)
  const [primaryBusy, setPrimaryBusy] = useState(false)
  const [skillTerminalOpen, setSkillTerminalOpen] = useState(false)
  const currentTip = FEATURE_TIPS.find((tip) => tip.id === tipId)
  const sessionSearchSetup = useSessionSearchTipSetup({
    dialogOpen: isOpen && currentTip?.id === 'agent-session-search'
  })

  useEffect(() => {
    openRef.current = isOpen
  }, [isOpen])

  const handleSkip = (): void => {
    setupRequestIdRef.current += 1
    setSkillTerminalOpen(false)
    setPrimaryBusy(false)
    closeModal()
  }

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      handleSkip()
    }
  }

  const openCliSettings = (): void => {
    openSettingsTarget({ pane: 'general', repoId: null, sectionId: 'cli' })
    openSettingsPage()
  }

  const openShortcutsSettings = (): void => {
    // Why: dismiss the tip when navigating away — the tip's job is done once
    // the user clicks through to rebind, and leaving it mounted behind the
    // settings page would re-appear on close.
    closeModal()
    openSettingsTarget({ pane: 'shortcuts', repoId: null })
    openSettingsPage()
  }

  const openVoiceSettings = (): void => {
    closeModal()
    openSettingsTarget({ pane: 'voice', repoId: null })
    openSettingsPage()
  }

  const openSessionSearchSettings = (): void => {
    closeModal()
    openSettingsTarget({ pane: 'session-history', repoId: null })
    openSettingsPage()
  }

  const enableOrchestrationSkillSetup = (): void => {
    localStorage.setItem(ORCHESTRATION_ENABLED_STORAGE_KEY, '1')
    localStorage.removeItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY)
    notifyOrchestrationSetupStateChanged()
  }

  const handlePrimaryAction = async (): Promise<void> => {
    if (!currentTip) {
      return
    }

    switch (currentTip.action) {
      case 'learn-cmd-j-palette': {
        // Why: passive education tip — acknowledging just dismisses; the rebind
        // path lives in Settings and is reachable from the palette itself.
        trackCmdJPaletteFeatureTipAcknowledged('app_open')
        closeModal()
        break
      }
      case 'enable-voice': {
        const voice = settings?.voice ?? getDefaultVoiceSettings()
        void updateSettings({
          voice: {
            ...voice,
            enabled: true
          }
        })
        closeModal()
        openSettingsTarget({ pane: 'voice', repoId: null })
        openSettingsPage()
        break
      }
      case 'enable-session-search': {
        if (sessionSearchSetup.stage === 'offer') {
          // Why: stay open through the first index so search is never offered half-built.
          setPrimaryBusy(true)
          await sessionSearchSetup.enable()
          setPrimaryBusy(false)
          break
        }
        closeModal()
        if (sessionSearchSetup.stage === 'ready') {
          showAiVaultSearch()
        }
        break
      }
      case 'setup-cli': {
        const setupRequestId = setupRequestIdRef.current + 1
        setupRequestIdRef.current = setupRequestId
        // Why: this modal is lazily mounted; closing it does not unmount the
        // component, so async install results must not reopen UI after dismissal.
        const canApplySetupResult = (): boolean =>
          mountedRef.current && openRef.current && setupRequestIdRef.current === setupRequestId
        trackOrcaCliFeatureTipSetupClicked('app_open')
        setPrimaryBusy(true)
        try {
          const result = await installCliFromFeatureTip(() => window.api.cli.install())
          if (result.kind === 'installed') {
            trackOrcaCliFeatureTipSetupResult('app_open', 'installed')
            if (!canApplySetupResult()) {
              return
            }
            enableOrchestrationSkillSetup()
            toast.success(
              translate(
                'auto.components.feature.tips.FeatureTipsModal.ce13a742d0',
                'Registered `orca` in PATH.'
              )
            )
            setSkillTerminalOpen(true)
            return
          }

          trackOrcaCliFeatureTipSetupResult('app_open', 'needs_attention')
          if (!canApplySetupResult()) {
            return
          }
          toast.warning(
            translate(
              'auto.components.feature.tips.FeatureTipsModal.1da82af45b',
              'Orca CLI needs attention'
            ),
            {
              description:
                result.status.detail ??
                translate(
                  'auto.components.feature.tips.FeatureTipsModal.d1a86c7eb5',
                  'Open Settings to finish CLI setup.'
                )
            }
          )
          closeModal()
          openCliSettings()
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to install Orca CLI.'
          if (
            import.meta.env.DEV &&
            message.includes('Development mode uses a generated launcher for validation only')
          ) {
            trackOrcaCliFeatureTipSetupResult('app_open', 'dev_preview')
            if (!canApplySetupResult()) {
              return
            }
            enableOrchestrationSkillSetup()
            toast.info(
              translate(
                'auto.components.feature.tips.FeatureTipsModal.53905bd076',
                'Development preview: opening skills setup terminal.'
              )
            )
            setSkillTerminalOpen(true)
            return
          }

          trackOrcaCliFeatureTipSetupResult('app_open', 'failed')
          if (canApplySetupResult()) {
            toast.error(message)
          }
        } finally {
          if (canApplySetupResult()) {
            setPrimaryBusy(false)
          }
        }
      }
    }
  }

  if (!currentTip) {
    return null
  }

  if (currentTip.action === 'setup-cli') {
    return (
      <CliSetupTipDialog
        open={isOpen}
        tip={currentTip}
        primaryBusy={primaryBusy}
        skillTerminalOpen={skillTerminalOpen}
        onOpenChange={handleOpenChange}
        onPrimaryAction={() => void handlePrimaryAction()}
        onSkip={handleSkip}
      />
    )
  }

  if (currentTip.action === 'learn-cmd-j-palette') {
    return (
      <CmdJPaletteTipDialog
        open={isOpen}
        tip={currentTip}
        primaryBusy={primaryBusy}
        onOpenChange={handleOpenChange}
        onPrimaryAction={() => void handlePrimaryAction()}
        onSkip={handleSkip}
        onRebindClick={openShortcutsSettings}
      />
    )
  }

  if (currentTip.action === 'enable-session-search') {
    return (
      <SessionSearchTipDialog
        open={isOpen}
        tip={currentTip}
        primaryBusy={primaryBusy}
        onOpenChange={handleOpenChange}
        onPrimaryAction={() => void handlePrimaryAction()}
        onSettingsClick={openSessionSearchSettings}
        stage={sessionSearchSetup.stage}
        status={sessionSearchSetup.status}
      />
    )
  }

  if (currentTip.action !== 'enable-voice') {
    currentTip satisfies never
    return null
  }

  return (
    <VoiceDictationTipDialog
      open={isOpen}
      tip={currentTip}
      primaryBusy={primaryBusy}
      onOpenChange={handleOpenChange}
      onPrimaryAction={() => void handlePrimaryAction()}
      onSkip={handleSkip}
      onVoiceSettingsClick={openVoiceSettings}
    />
  )
}
