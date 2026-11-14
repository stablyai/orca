import { useEffect, useRef } from 'react'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import { stringifyAgentDefaultEnvDraft } from '../../../agent/launch-settings/agent-default-env-draft'
import { resolveTuiAgentPermissionMode } from '../../../../../../shared/agent-launch/permissions/tui-agent-permissions'
import { scheduleSettingsListReveal } from '../../section-layout/settings-list-scroll'

export function agentCatalogRowInitiallyExpanded(row: AgentCatalogRowProps): boolean {
  const envSummary =
    row.environmentNames?.join(' ') ?? stringifyAgentDefaultEnvDraft(row.envOverride)
  return (
    Boolean(row.cmdOverride) ||
    (row.argsOverride !== row.defaultArgs &&
      resolveTuiAgentPermissionMode({
        agent: row.agentId,
        agentArgs: row.argsOverride,
        agentEnv: row.envOverride
      }) === 'mixed') ||
    envSummary !== stringifyAgentDefaultEnvDraft(row.defaultEnv)
  )
}

export function useAgentCatalogRowExpansion(cmdOpen: boolean, setCmdOpen: (open: boolean) => void) {
  const rowRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const permissionRef = useRef<HTMLDivElement>(null)
  const revealFrame = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (revealFrame.current !== null) {
        cancelAnimationFrame(revealFrame.current)
      }
    },
    []
  )
  const reveal = (focusPermission = false): void => {
    if (revealFrame.current !== null) {
      cancelAnimationFrame(revealFrame.current)
    }
    const scroller = rowRef.current?.closest('[data-settings-scroll-list]')
    revealFrame.current = scheduleSettingsListReveal(() => {
      const panel = panelRef.current
      if (!panel || (scroller && panel.closest('[data-settings-scroll-list]') !== scroller)) {
        return null
      }
      if (focusPermission) {
        const control = permissionRef.current
        const button =
          control?.querySelector<HTMLElement>('[aria-checked="true"]') ??
          control?.querySelector<HTMLElement>('button')
        button?.focus({ preventScroll: true })
        return button ?? panel
      }
      return panel
    })
  }
  const openPermission = (): void => {
    setCmdOpen(true)
    reveal(true)
  }
  const toggleOpen = (): void => {
    setCmdOpen(!cmdOpen)
    if (!cmdOpen) {
      reveal()
    } else if (revealFrame.current !== null) {
      cancelAnimationFrame(revealFrame.current)
    }
  }
  return { rowRef, panelRef, permissionRef, openPermission, toggleOpen }
}
