import type React from 'react'
import type { Translate } from '@/i18n/use-translate'
import { SettingsSection } from '../section-layout/SettingsSection'
import type { SettingsRenderContext } from '../page/settings-render-context'
import { AgentAccountsJumpRow } from './AgentAccountsJumpRow'
import { AgentAccountsSubsection, type AgentAccountsPart } from './AgentAccountsSubsection'

/** The "This computer" / "Selected host" part of Settings → Agent accounts. */
export const AGENT_ACCOUNTS_HOST_PART_ID = 'accounts-this-host'

type AgentAccountsSettingsSectionProps = React.ComponentProps<typeof SettingsSection> & {
  context: SettingsRenderContext
  t: Translate
  additionalParts: readonly AgentAccountsPart[]
  lead: React.ReactNode
}

/**
 * Settings → Agent accounts: one page for agent sign-ins. "This computer" (or the host picked in the
 * scope picker) holds provider accounts, switching and usage (`children`, under `description`);
 * `additionalParts` lets a build add more parts below it. With more than one part, a jump row under
 * the page description links to each. `lead` sits above the parts (Orca Cloud builds: the link to
 * Cloud agent sign-ins).
 */
export function AgentAccountsSettingsSection({
  context,
  t,
  additionalParts,
  lead,
  description,
  children,
  ...sectionProps
}: AgentAccountsSettingsSectionProps): React.JSX.Element | null {
  const { model, view } = context
  const hostPartTitle =
    model.settingsHostScope.target.kind === 'local'
      ? t('settings.agentAccounts.thisComputer', 'This computer')
      : t('settings.agentAccounts.selectedHost', 'Selected host')
  return (
    <SettingsSection
      {...sectionProps}
      description={t(
        'settings.agentAccounts.pageDescription',
        'Sign-ins, account switching and usage for your agents.'
      )}
    >
      {view.isSectionMounted('accounts') ? (
        <>
          <AgentAccountsJumpRow
            links={[
              { id: AGENT_ACCOUNTS_HOST_PART_ID, title: hostPartTitle },
              ...additionalParts.map(({ id, title }) => ({ id, title }))
            ]}
          />
          {lead}
          <AgentAccountsSubsection
            id={AGENT_ACCOUNTS_HOST_PART_ID}
            title={hostPartTitle}
            description={description}
          >
            {children}
          </AgentAccountsSubsection>
          {additionalParts.map((part) => (
            <AgentAccountsSubsection
              key={part.id}
              id={part.id}
              title={part.title}
              description={part.description}
            >
              {part.content}
            </AgentAccountsSubsection>
          ))}
        </>
      ) : null}
    </SettingsSection>
  )
}
