import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { i18n } from '@/i18n/i18n'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type {
  WorkspaceCleanupReport,
  WorkspaceCleanupRun,
  WorkspaceCleanupRunRow
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { WorkspaceCleanupActivityList } from './workspace-cleanup-activity-list'
import { WorkspaceCleanupAutomaticSection } from './workspace-cleanup-automatic-section'

// Measured in the app: content is the window minus 395px (app rail, settings sidebar, gutters), so the
// 600px minimum window leaves 205px of content and a 1115px window leaves 720px.
const NARROW_PANE_CONTENT_PX = 205
const WIDE_PANE_CONTENT_PX = 720
// The fixture frame pads its content by 16px a side.
const FRAME_PADDING_PX = 32

const NOW = 1_763_041_440_000
const MB = 1024 * 1024

const LONG_PROJECT = 'customer-facing-analytics-dashboard-monorepo'
// Errors carry raw host text; a long token with no break opportunity must still fit.
const UNBROKEN_TOKEN = '0x7f3a9c2e4b1d8f6a0c5e3b9d7f1a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c'

function row(
  name: string,
  overrides: Partial<WorkspaceCleanupRunRow> & Pick<WorkspaceCleanupRunRow, 'outcome'>
): WorkspaceCleanupRunRow {
  const repoName = overrides.repoName ?? 'example-project'
  return {
    worktreeId: `${repoName}::/repo/${name}`,
    repoId: repoName,
    repoName,
    displayName: name,
    branch: name,
    path: `/Users/me/code/${repoName}/${name}`,
    ...overrides
  }
}

const RUNS: WorkspaceCleanupRun[] = [
  {
    id: 'run-2',
    trigger: 'settings',
    startedAt: NOW,
    finishedAt: NOW + 4_000,
    counts: { removed: 2, archived: 1, kept: 128, failed: 1 },
    freedBytes: 1_384 * MB,
    chatHistory: { deleted: 38, failed: 2, freedBytes: 214 * MB },
    rows: [
      row('fix-settings-pane-width', {
        outcome: 'removed',
        reason: 'merged',
        prNumber: 42,
        sizeBytes: 1_288 * MB
      }),
      row('worker-translate-catalogs', {
        outcome: 'archived',
        reason: 'orchestration-worker',
        sizeBytes: 96 * MB
      }),
      // A 40+ character name in a long-named project, never measured: no size.
      row('investigate-flaky-settings-pane-layout-on-minimum-window', {
        outcome: 'removed',
        reason: 'inactive',
        repoName: LONG_PROJECT
      }),
      row('release-notes', {
        outcome: 'failed',
        reason: 'inactive',
        error:
          "EACCES: permission denied, rmdir '/Users/me/code/example-project/release-notes/node_modules/.cache'"
      }),
      row('workspace-1', { outcome: 'kept', keepCause: 'pinned' }),
      row('workspace-2', {
        outcome: 'kept',
        keepCause: 'ignored-files',
        // Long sample paths widen the shared reason column; other rows' names must still read.
        ignoredFiles: {
          count: 3,
          samplePaths: [
            '.env',
            'packages/analytics-dashboard/config/local.development.override.json',
            'services/ingest/.secrets/service-account-credentials.production.json'
          ],
          complete: true
        }
      }),
      row('workspace-3', {
        outcome: 'kept',
        keepCause: 'waiting',
        waiting: { elapsedDays: 2, afterDays: 30 }
      }),
      row('workspace-4', { outcome: 'kept', keepCause: 'unsaved-editor-changes' }),
      row('workspace-5', { outcome: 'kept', keepCause: 'terminal-running' }),
      row('workspace-6', { outcome: 'kept', keepCause: 'uncommitted-changes' }),
      row('workspace-7-with-a-much-longer-descriptive-branch-name', {
        outcome: 'kept',
        keepCause: 'unpushed-commits',
        repoName: LONG_PROJECT
      })
    ]
  },
  {
    id: 'run-error',
    trigger: 'startup',
    startedAt: NOW - 1_800_000,
    finishedAt: NOW - 1_799_000,
    counts: { removed: 0, archived: 0, kept: 0, failed: 0 },
    freedBytes: 0,
    rows: [],
    error: `Couldn't read the workspace list: unexpected reply ${UNBROKEN_TOKEN}`
  },
  {
    id: 'run-1',
    trigger: 'hourly',
    startedAt: NOW - 3_600_000,
    finishedAt: NOW - 3_596_000,
    counts: { removed: 0, archived: 0, kept: 4, failed: 0 },
    freedBytes: 0,
    rows: []
  }
]

// The newest run couldn't finish, so the status line repeats its unbroken error token.
const ERROR_FIRST_RUNS = [RUNS[1], RUNS[0], RUNS[2]]

// Why: these keys are not yet in the shipped de/ru/ja catalogs. This is width-stress copy, mostly
// from draft translations (automatic.* and chat-history lines are approximations of similar length),
// so the fixture exercises realistic lengths; it is not reviewed catalog source.
const STRESS_COPY: Record<'de' | 'ru' | 'ja', Record<string, string>> = {
  de: {
    'automatic.title': 'Automatische Bereinigung',
    'automatic.on': 'An',
    'automatic.runNow': 'Regeln jetzt ausführen',
    'chatHistory.title': 'Chatverlauf',
    'activity.chatsDeleted_other': '{{count}} Chats aus gelöschten Arbeitsbereichen gelöscht',
    'activity.chatsFailed_other': '{{count}} Chats konnten nicht gelöscht werden',
    'activity.notListed_other':
      '{{count}} weitere beibehaltene Arbeitsbereiche sind nicht aufgeführt.',
    'activity.unfinished': 'Abschluss fehlgeschlagen',
    'keep.unpushedCommits': 'Nicht gepushte Commits',
    'reason.inactive': 'Inaktiv',
    'trigger.startup': 'Beim Start',
    'activity.nothingRemoved': 'Nichts aufzuräumen',
    'status.justNow': 'gerade eben',
    'activity.removed': 'Entfernt · {{count}}',
    'activity.kept': 'Beibehalten · {{count}}',
    'activity.failed': 'Fehlgeschlagen · {{count}}',
    'activity.removedCount': 'Entfernt: {{count}}',
    'activity.keptCount': 'Beibehalten: {{count}}',
    'activity.failedCount': 'Fehlgeschlagen: {{count}}',
    'activity.deleted': 'Gelöscht',
    'activity.archived': 'Archiviert',
    'activity.waiting': '{{elapsed}} von {{after}} Tagen inaktiv',
    'activity.showMore': '{{count}} weitere anzeigen',
    'keep.pinned': 'Angeheftet',
    'keep.ignoredFiles': 'Ignorierte Dateien',
    'keep.unsavedEditorChanges': 'Ungespeicherte Editor-Änderungen',
    'keep.terminalRunning': 'Terminal führt einen Prozess aus',
    'keep.uncommittedChanges': 'Nicht committete Änderungen',
    'reason.merged': 'Gemergt',
    'reason.orchestrationWorker': 'Orchestrierungs-Worker',
    'trigger.settings': 'Nach einer Regeländerung',
    'trigger.hourly': 'Stündlich',
    'status.lastRunFreed_other':
      'Letzter Lauf ({{when}}): {{count}} Arbeitsbereiche entfernt und {{size}} freigegeben.',
    'status.nextRun': 'Nächster Lauf: {{when}}.'
  },
  ru: {
    'automatic.title': 'Автоматическая очистка',
    'automatic.on': 'Вкл.',
    'automatic.runNow': 'Выполнить правила сейчас',
    'chatHistory.title': 'История чатов',
    'activity.chatsDeleted_many': 'Удалено {{count}} чатов из удалённых рабочих пространств',
    'activity.chatsFailed_few': 'Не удалось удалить {{count}} чата',
    'activity.notListed_one': 'Ещё {{count}} оставленное рабочее пространство не указано.',
    'activity.unfinished': 'Не удалось завершить',
    'keep.unpushedCommits': 'Неотправленные коммиты',
    'reason.inactive': 'Неактивно',
    'trigger.startup': 'При запуске',
    'activity.nothingRemoved': 'Нечего очищать',
    'status.justNow': 'только что',
    'status.lastRunFreed_few':
      'Последний запуск ({{when}}) убрал {{count}} рабочих пространства и освободил {{size}}.',
    'activity.removed': 'Убрано · {{count}}',
    'activity.kept': 'Оставлено · {{count}}',
    'activity.failed': 'Сбои · {{count}}',
    'activity.removedCount': 'Убрано: {{count}}',
    'activity.keptCount': 'Оставлено: {{count}}',
    'activity.failedCount': 'Сбоев: {{count}}',
    'activity.deleted': 'Удалено',
    'activity.archived': 'Архивировано',
    'activity.waiting': 'Без активности {{elapsed}} из {{after}} дней',
    'activity.showMore': 'Показать ещё {{count}}',
    'keep.pinned': 'Закреплено',
    'keep.ignoredFiles': 'Игнорируемые файлы',
    'keep.unsavedEditorChanges': 'Несохранённые изменения в редакторе',
    'keep.terminalRunning': 'Терминал выполняет процесс',
    'keep.uncommittedChanges': 'Незакоммиченные изменения',
    'reason.merged': 'Слито',
    'reason.orchestrationWorker': 'Исполнитель оркестрации',
    'trigger.settings': 'После изменения правила',
    'trigger.hourly': 'Каждый час',
    'status.lastRunFreed_other':
      'Последний запуск ({{when}}) убрал {{count}} рабочего пространства и освободил {{size}}.',
    'status.nextRun': 'Следующий запуск: {{when}}.'
  },
  ja: {
    'automatic.title': '自動クリーンアップ',
    'automatic.on': 'オン',
    'automatic.runNow': '今すぐルールを実行',
    'chatHistory.title': 'チャット履歴',
    'activity.chatsDeleted_other': '削除されたワークスペースのチャットを{{count}}件削除しました',
    'activity.chatsFailed_other': '{{count}}件のチャットを削除できませんでした',
    'activity.notListed_other': 'ほかに{{count}}件の保持されたワークスペースが表示されていません。',
    'activity.unfinished': '完了できませんでした',
    'keep.unpushedCommits': '未プッシュのコミット',
    'reason.inactive': '非アクティブ',
    'trigger.startup': '起動時',
    'activity.nothingRemoved': 'クリーンアップの対象なし',
    'status.justNow': 'たった今',
    'activity.removed': '除去済み · {{count}}',
    'activity.kept': '保持済み · {{count}}',
    'activity.failed': '失敗 · {{count}}',
    'activity.removedCount': '除去：{{count}}',
    'activity.keptCount': '保持：{{count}}',
    'activity.failedCount': '失敗：{{count}}',
    'activity.deleted': '削除済み',
    'activity.archived': 'アーカイブ済み',
    'activity.waiting': '非アクティブ期間：{{elapsed}}日／{{after}}日',
    'activity.showMore': 'さらに{{count}}件表示',
    'keep.pinned': 'ピン留め済み',
    'keep.ignoredFiles': '無視されたファイル',
    'keep.unsavedEditorChanges': 'エディターの未保存の変更',
    'keep.terminalRunning': 'ターミナルでプロセス実行中',
    'keep.uncommittedChanges': '未コミットの変更',
    'reason.merged': 'マージ済み',
    'reason.orchestrationWorker': 'オーケストレーションワーカー',
    'trigger.settings': 'ルール変更後',
    'trigger.hourly': '毎時',
    'status.lastRunFreed_other':
      '前回の実行（{{when}}）で{{count}}件のワークスペースを除去し、{{size}}を解放しました。',
    'status.nextRun': '次回の実行：{{when}}。'
  }
}

type Catalog = { [key: string]: string | Catalog }

function nest(entries: Record<string, string>): Catalog {
  const root: Catalog = {}
  for (const [path, value] of Object.entries(entries)) {
    const keys = ['components', 'settings', 'workspaceCleanup', ...path.split('.')]
    let node = root
    for (const key of keys.slice(0, -1)) {
      const child = node[key]
      if (typeof child === 'object') {
        node = child
      } else {
        const created: Catalog = {}
        node[key] = created
        node = created
      }
    }
    node[keys.at(-1)!] = value
  }
  return root
}

function ActivityPane({ runs }: { runs: WorkspaceCleanupRun[] }): React.JSX.Element {
  const report: WorkspaceCleanupReport = { runs, running: false, nextRunAt: NOW + 3_600_000 }
  return (
    <div className="space-y-8">
      <WorkspaceCleanupAutomaticSection
        anyRuleOn
        report={report}
        readAt={NOW + 60_000}
        cleaningUp={false}
        onCleanUpNow={() => {}}
        showRules={false}
      >
        {null}
      </WorkspaceCleanupAutomaticSection>
      <SettingsGroup title="Activity">
        <WorkspaceCleanupActivityList runs={runs} />
      </SettingsGroup>
    </div>
  )
}

function paneFixture(
  width: number,
  locale: 'en' | keyof typeof STRESS_COPY,
  runs = RUNS,
  overrides: Record<string, string> = {}
): ComponentFixture {
  return defineFixture({
    width: width + FRAME_PADDING_PX,
    store: { settings: { ...getDefaultSettings('/tmp'), uiLanguage: locale } },
    setup: () => {
      const copy = { ...(locale === 'en' ? {} : STRESS_COPY[locale]), ...overrides }
      if (Object.keys(copy).length > 0) {
        i18n.addResourceBundle(locale, 'translation', nest(copy), true, true)
      }
    },
    render: () => <ActivityPane runs={runs} />
  })
}

export const narrowEnglish = paneFixture(NARROW_PANE_CONTENT_PX, 'en')
export const narrowGerman = paneFixture(NARROW_PANE_CONTENT_PX, 'de')
export const narrowRussian = paneFixture(NARROW_PANE_CONTENT_PX, 'ru')
export const narrowJapanese = paneFixture(NARROW_PANE_CONTENT_PX, 'ja')
export const wideEnglish = paneFixture(WIDE_PANE_CONTENT_PX, 'en')
export const wideGerman = paneFixture(WIDE_PANE_CONTENT_PX, 'de')
export const wideRussian = paneFixture(WIDE_PANE_CONTENT_PX, 'ru')
export const wideJapanese = paneFixture(WIDE_PANE_CONTENT_PX, 'ja')
export const narrowRunError = paneFixture(NARROW_PANE_CONTENT_PX, 'en', ERROR_FIRST_RUNS)
export const wideRunError = paneFixture(WIDE_PANE_CONTENT_PX, 'en', ERROR_FIRST_RUNS)

// Longer than any shipped reason: a CJK label and an unbroken token, so reason pills must wrap.
const FORCED_LONG_REASONS = {
  'reason.orchestrationWorker':
    'オーケストレーションワーカーによって作成された一時的なワークスペース',
  'reason.inactive': 'Inaktivitätsgrenzwertüberschreitungsbereinigungsregel'
}
// English: one label with spaces, one unbroken token.
const FORCED_LONG_REASONS_EN = {
  'reason.orchestrationWorker':
    'Temporary workspace created by an orchestration worker for a delegated task',
  'reason.inactive': 'Inactivitythresholdexceededautomaticcleanuprule'
}
// Russian: a long Cyrillic label, plus the unbroken German token.
const FORCED_LONG_REASONS_RU = {
  ...FORCED_LONG_REASONS,
  'reason.orchestrationWorker':
    'Временное рабочее пространство, созданное исполнителем оркестрации для поручения'
}
// 618px of content is where rows switch to columns (a 36rem run).
const WIDE_BOUNDARY_CONTENT_PX = 618
export const narrowForcedLongReasons = paneFixture(
  NARROW_PANE_CONTENT_PX,
  'ja',
  RUNS,
  FORCED_LONG_REASONS
)
export const narrowForcedLongReasonsEnglish = paneFixture(
  NARROW_PANE_CONTENT_PX,
  'en',
  RUNS,
  FORCED_LONG_REASONS_EN
)
export const narrowForcedLongReasonsGerman = paneFixture(
  NARROW_PANE_CONTENT_PX,
  'de',
  RUNS,
  FORCED_LONG_REASONS
)
export const narrowForcedLongReasonsRussian = paneFixture(
  NARROW_PANE_CONTENT_PX,
  'ru',
  RUNS,
  FORCED_LONG_REASONS_RU
)
export const wideBoundaryForcedLongReasons = paneFixture(
  WIDE_BOUNDARY_CONTENT_PX,
  'ja',
  RUNS,
  FORCED_LONG_REASONS
)
