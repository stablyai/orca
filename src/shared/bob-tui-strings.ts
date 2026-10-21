/**
 * The Bob TUI strings Orca's screen matchers key on, in every locale Bob ships.
 *
 * Why every locale: since 2.0.5 Bob translates its whole TUI, picking the locale from
 * `settings.locale`, else `LC_ALL || LC_MESSAGES || LANG` — the PTY inherits the user's env, so an
 * English-only matcher silently never fires for a German or Japanese user. Values are copied
 * verbatim from bobshell 2.0.6 `dist/translations/<locale>.json` (ar, de, en, es, fr, id, it, ja,
 * ko, pl, pt-BR, ru, tr, zh-CN, zh-TW); `Approve commands:` has no translation key and stays English.
 */

/** The approval modal's first menu row, the one line every modal shape shares. */
export const BOB_APPROVE_ONCE_LABELS = [
  'Approve Once',
  'الموافقة مرة واحدة',
  'Einmalig genehmigen',
  'Aprobar una vez',
  'Approuver une fois',
  'Setujui Sekali',
  'Approva una volta',
  '一度だけ承認',
  '한 번만 승인',
  'Zatwierdź raz',
  'Aprovar uma vez',
  'Одобрить один раз',
  'Bir Kez Onayla',
  '批准一次',
  '核准一次'
] as const

/** The spawn modal's second row; `{{group}}` is the subagent group name Bob fills in. */
export const BOB_APPROVE_GROUP_TOOLS_TEMPLATES = [
  'Approve {{group}} tools for task',
  'الموافقة على أدوات {{group}} للمهمة',
  '{{group}}-Tools für Aufgabe genehmigen',
  'Aprobar herramientas de {{group}} para la tarea',
  'Approuver les outils {{group}} pour la tâche',
  'Setujui alat {{group}} untuk tugas',
  "Approva gli strumenti {{group}} per l'attività",
  'タスク用に{{group}}個のツールを承認',
  '이 작업에서 {{group}} 도구 승인',
  'Zatwierdź narzędzia {{group}} dla zadania',
  'Aprovar ferramentas {{group}} para a tarefa',
  'Одобрить инструменты {{group}} для задачи',
  'Görev için {{group}} araçlarını onayla',
  '批准任务使用 {{group}} 工具',
  '核准 {{group}} 工具以執行任務'
] as const

// Why a prefix: the first two clauses of the composer placeholder avoid the brittle later hints
// (`/ for commands, $ for skills`) and shell-prompt glyph false positives.
export const BOB_COMPOSER_PLACEHOLDER_PREFIXES = [
  'Build Anything, @ for context',
  'ابنِ أي شيء، @ للسياق',
  'Baue Alles, @ für Kontext',
  'Construye Cualquier Cosa, @ para contexto',
  "Créez n'importe quoi, @ pour le contexte",
  'Bangun Apa Saja, @ untuk konteks',
  'Costruisci qualsiasi cosa, @ per il contesto',
  '何でも作成、@ でコンテキスト',
  '무엇이든 만드세요, @로 컨텍스트',
  'Buduj cokolwiek, @ dla kontekstu',
  'Construa Qualquer Coisa, @ para contexto',
  'Создавайте что угодно, @ для контекста',
  'Her Şeyi Oluştur, bağlam için @',
  '构建任何东西,@ 添加上下文',
  '打造任何東西,@ 取得情境資訊'
] as const
