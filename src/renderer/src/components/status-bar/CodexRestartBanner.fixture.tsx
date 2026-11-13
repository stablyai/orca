import { defineFixture } from '../../component-fixtures/component-fixture'
import { CodexRestartBanner } from './CodexRestartBanner'
import { CodexResetCredits } from './CodexResetCredits'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const codex: ProviderRateLimits = {
  provider: 'codex',
  status: 'ok',
  error: null,
  updatedAt: 0,
  session: { usedPercent: 32, windowMinutes: 300, resetsAt: null, resetDescription: null },
  weekly: { usedPercent: 58, windowMinutes: 10080, resetsAt: null, resetDescription: null }
}

export const stale = defineFixture({
  width: 440,
  store: {
    tabsByWorktree: {
      fixture: [
        {
          id: 'fixture-tab',
          worktreeId: 'fixture',
          createdAt: 1,
          ptyId: 'fixture-pty-1',
          title: 'Codex',
          customTitle: null,
          color: null,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      'fixture-tab': {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: '00000000-0000-4000-8000-000000000001' },
          second: { type: 'leaf', leafId: '00000000-0000-4000-8000-000000000002' }
        },
        activeLeafId: '00000000-0000-4000-8000-000000000001',
        expandedLeafId: null,
        ptyIdsByLeafId: {
          '00000000-0000-4000-8000-000000000001': 'fixture-pty-1',
          '00000000-0000-4000-8000-000000000002': 'fixture-pty-2'
        }
      }
    },
    paneAccountRestarts: {},
    ptyIdsByTabId: { 'fixture-tab': ['fixture-pty-1', 'fixture-pty-2'] },
    codexRestartNoticeByPtyId: {
      'fixture-pty-1': { previousAccountLabel: 'Personal', nextAccountLabel: 'Work' },
      'fixture-pty-2': { previousAccountLabel: 'Personal', nextAccountLabel: 'Work' }
    }
  },
  render: () => (
    <div className="flex h-[400px] items-end bg-background p-4">
      <ProviderDetailsMenu
        provider={codex}
        compact={false}
        iconOnly={false}
        ariaLabel="Codex"
        open
        variant="account"
        accountLabel="Work"
        bannerContent={<CodexRestartBanner />}
        panelFooter={
          <CodexResetCredits
            resetCreditCount={3}
            resetCreditExpiry="1 expires in 2 days"
            canRedeemReset
            isRedeemingReset={false}
            onReset={() => {}}
          />
        }
      />
    </div>
  )
})
