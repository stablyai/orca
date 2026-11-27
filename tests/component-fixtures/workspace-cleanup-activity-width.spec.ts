import { expect, test, type Page } from '@playwright/test'

// Fixtures render the real cleanup status and activity list at the settings pane's content width:
// 205px at the 600px minimum window, 720px at a normal one. Locales carry long German/Russian/Japanese copy.
type Locale = 'en' | 'de' | 'ru' | 'ja'
const FIXTURES: { name: string; locale: Locale }[] = [
  { name: 'narrowEnglish', locale: 'en' },
  { name: 'narrowGerman', locale: 'de' },
  { name: 'narrowRussian', locale: 'ru' },
  { name: 'narrowJapanese', locale: 'ja' },
  { name: 'wideEnglish', locale: 'en' },
  { name: 'wideGerman', locale: 'de' },
  { name: 'wideRussian', locale: 'ru' },
  { name: 'wideJapanese', locale: 'ja' },
  { name: 'narrowRunError', locale: 'en' },
  { name: 'wideRunError', locale: 'en' }
]

const SHOW_MORE = /^Show 3 more|3 weitere anzeigen|Показать ещё 3|さらに3件表示/
const UNBROKEN_TOKEN = '0x7f3a9c2e4b1d8f6a0c5e3b9d7f1a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c'
const LONG_PROJECT = 'customer-facing-analytics-dashboard-monorepo'

// Locale copy the fixture seeds; each entry is a fact a receipt must keep readable.
const LABELS: Record<Locale, Record<string, string>> = {
  en: {
    removed: '3 removed',
    kept: '128 kept',
    failed: '1 failed',
    deleted: 'Deleted',
    archived: 'Archived',
    merged: 'Merged · #42',
    worker: 'Orchestration worker',
    inactive: 'Inactive',
    pinned: 'Pinned',
    ignored: 'Ignored files',
    waiting: 'Inactive 2 of 30 days',
    unsaved: 'Unsaved editor changes',
    terminal: 'Terminal running a process',
    uncommitted: 'Uncommitted changes',
    unpushed: 'Unpushed commits',
    chatsDeleted: 'Deleted 38 chats from deleted workspaces',
    chatsFailed: "2 chats couldn't be deleted",
    unfinished: "Couldn't finish",
    nothing: 'Nothing to clean',
    keptFour: '4 kept',
    notListed: '121 more kept workspaces are not listed.'
  },
  de: {
    removed: 'Entfernt: 3',
    kept: 'Beibehalten: 128',
    failed: 'Fehlgeschlagen: 1',
    deleted: 'Gelöscht',
    archived: 'Archiviert',
    merged: 'Gemergt · #42',
    worker: 'Orchestrierungs-Worker',
    inactive: 'Inaktiv',
    pinned: 'Angeheftet',
    ignored: 'Ignorierte Dateien',
    waiting: '2 von 30 Tagen inaktiv',
    unsaved: 'Ungespeicherte Editor-Änderungen',
    terminal: 'Terminal führt einen Prozess aus',
    uncommitted: 'Nicht committete Änderungen',
    unpushed: 'Nicht gepushte Commits',
    chatsDeleted: '38 Chats aus gelöschten Arbeitsbereichen gelöscht',
    chatsFailed: '2 Chats konnten nicht gelöscht werden',
    unfinished: 'Abschluss fehlgeschlagen',
    nothing: 'Nichts aufzuräumen',
    keptFour: 'Beibehalten: 4',
    notListed: '121 weitere beibehaltene Arbeitsbereiche sind nicht aufgeführt.'
  },
  ru: {
    removed: 'Убрано: 3',
    kept: 'Оставлено: 128',
    failed: 'Сбоев: 1',
    deleted: 'Удалено',
    archived: 'Архивировано',
    merged: 'Слито · #42',
    worker: 'Исполнитель оркестрации',
    inactive: 'Неактивно',
    pinned: 'Закреплено',
    ignored: 'Игнорируемые файлы',
    waiting: 'Без активности 2 из 30 дней',
    unsaved: 'Несохранённые изменения в редакторе',
    terminal: 'Терминал выполняет процесс',
    uncommitted: 'Незакоммиченные изменения',
    unpushed: 'Неотправленные коммиты',
    chatsDeleted: 'Удалено 38 чатов из удалённых рабочих пространств',
    chatsFailed: 'Не удалось удалить 2 чата',
    unfinished: 'Не удалось завершить',
    nothing: 'Нечего очищать',
    keptFour: 'Оставлено: 4',
    notListed: 'Ещё 121 оставленное рабочее пространство не указано.'
  },
  ja: {
    removed: '除去：3',
    kept: '保持：128',
    failed: '失敗：1',
    deleted: '削除済み',
    archived: 'アーカイブ済み',
    merged: 'マージ済み · #42',
    worker: 'オーケストレーションワーカー',
    inactive: '非アクティブ',
    pinned: 'ピン留め済み',
    ignored: '無視されたファイル',
    waiting: '非アクティブ期間：2日／30日',
    unsaved: 'エディターの未保存の変更',
    terminal: 'ターミナルでプロセス実行中',
    uncommitted: '未コミットの変更',
    unpushed: '未プッシュのコミット',
    chatsDeleted: '削除されたワークスペースのチャットを38件削除しました',
    chatsFailed: '2件のチャットを削除できませんでした',
    unfinished: '完了できませんでした',
    nothing: 'クリーンアップの対象なし',
    keptFour: '保持：4',
    notListed: 'ほかに121件の保持されたワークスペースが表示されていません。'
  }
}

// Facts visible once every run is expanded; `hiddenUntilShowMore` rows appear after "Show 3 more".
function expectedFacts(locale: Locale): { visible: string[]; hiddenUntilShowMore: string[] } {
  const l = LABELS[locale]
  return {
    visible: [
      'fix-settings-pane-width',
      'worker-translate-catalogs',
      'release-notes',
      'investigate-flaky-settings-pane-layout-on-minimum-window',
      'workspace-1',
      'workspace-2',
      'workspace-3',
      'workspace-4',
      'example-project',
      LONG_PROJECT,
      l.removed,
      l.kept,
      l.failed,
      l.deleted,
      l.archived,
      '1.26 GB',
      '96.0 MB',
      l.merged,
      l.worker,
      l.inactive,
      l.pinned,
      l.ignored,
      l.waiting,
      l.unsaved,
      'packages/analytics-dashboard/config/local.development.override.json',
      'EACCES: permission denied',
      UNBROKEN_TOKEN
    ],
    hiddenUntilShowMore: [
      'workspace-5',
      'workspace-6',
      'workspace-7-with-a-much-longer-descriptive-branch-name',
      l.terminal,
      l.uncommitted,
      l.unpushed
    ]
  }
}

const ROW_ERROR =
  "EACCES: permission denied, rmdir '/Users/me/code/example-project/release-notes/node_modules/.cache'"
const RUN_ERROR = `Couldn't read the workspace list: unexpected reply ${UNBROKEN_TOKEN}`
const IGNORED_SAMPLES = [
  '.env',
  'packages/analytics-dashboard/config/local.development.override.json',
  'services/ingest/.secrets/service-account-credentials.production.json'
]
const WORKSPACES = [
  'fix-settings-pane-width',
  'worker-translate-catalogs',
  'investigate-flaky-settings-pane-layout-on-minimum-window',
  'release-notes',
  'workspace-1',
  'workspace-2',
  'workspace-3',
  'workspace-4',
  'workspace-5',
  'workspace-6',
  'workspace-7-with-a-much-longer-descriptive-branch-name'
]

// A fact is matched as an element's whole text, unless `partOf` marks it as part of a longer line.
type Fact = { text: string; partOf?: true }
// Facts that must read inside one scope: the smallest element around `anchor` that holds them all,
// which may not reach text from another row or run (`exclude`). A fact that moved elsewhere fails.
type Scope = { anchor: string; facts: Fact[]; exclude: string[] }

function rowScope(name: string, facts: string[]): Scope {
  return {
    anchor: name,
    facts: [name, ...facts].map((text) => ({ text })),
    exclude: WORKSPACES.filter((other) => other !== name)
  }
}

// Every seeded row and run with its own facts; `concealed` rows sit behind "Show 3 more".
function scopes(locale: Locale): { shown: Scope[]; concealed: Scope[]; afterShowMore: Scope[] } {
  const l = LABELS[locale]
  const ignored = `${l.ignored} · ${IGNORED_SAMPLES.join(', ')}`
  const otherRuns = [l.unfinished, l.nothing]
  const busyRun = (extra: Fact[]): Scope => ({
    anchor: l.removed,
    facts: [
      { text: l.removed },
      { text: '38 chats deleted' },
      { text: l.kept },
      { text: l.failed },
      { text: l.chatsDeleted, partOf: true },
      { text: '214 MB' },
      { text: l.chatsFailed },
      ...extra
    ],
    exclude: otherRuns
  })
  const shown = [
    rowScope('fix-settings-pane-width', ['example-project', l.merged, l.deleted, '1.26 GB']),
    rowScope('worker-translate-catalogs', ['example-project', l.worker, l.archived, '96.0 MB']),
    rowScope('investigate-flaky-settings-pane-layout-on-minimum-window', [
      LONG_PROJECT,
      l.inactive,
      l.deleted
    ]),
    rowScope('release-notes', ['example-project', ROW_ERROR]),
    rowScope('workspace-1', ['example-project', l.pinned]),
    rowScope('workspace-2', ['example-project', ignored]),
    rowScope('workspace-3', ['example-project', l.waiting]),
    rowScope('workspace-4', ['example-project', l.unsaved]),
    busyRun([]),
    {
      anchor: l.unfinished,
      facts: [{ text: l.unfinished }, { text: RUN_ERROR }],
      exclude: [l.removed, l.nothing]
    },
    {
      anchor: l.nothing,
      facts: [{ text: l.nothing }, { text: l.keptFour }],
      exclude: [l.removed, l.unfinished]
    }
  ]
  const concealed = [
    rowScope('workspace-5', ['example-project', l.terminal]),
    rowScope('workspace-6', ['example-project', l.uncommitted]),
    rowScope('workspace-7-with-a-much-longer-descriptive-branch-name', [LONG_PROJECT, l.unpushed])
  ]
  // Once every kept row shows, the run says how many it did not list.
  const afterShowMore = [
    ...shown.slice(0, -3),
    busyRun([{ text: l.notListed }]),
    ...shown.slice(-2),
    ...concealed
  ]
  return { shown, concealed, afterShowMore }
}

// Problems with each scope's facts: missing from the scope, or any of its text hidden, clipped or
// outside the pane. Each text node is checked, so a fact cannot pass with part of it concealed.
async function scopedFactProblems(page: Page, scopeList: Scope[]) {
  return page.locator('#component-fixture-frame').evaluate((frame, scopeList) => {
    const rect = frame.getBoundingClientRect()
    const style = getComputedStyle(frame)
    const left = rect.left + Number.parseFloat(style.paddingLeft)
    const right = rect.right - Number.parseFloat(style.paddingRight)
    const all = [...frame.querySelectorAll<HTMLElement>('*')]
    const textOf = (element: Element) => element.textContent?.trim() ?? ''

    const readable = (element: HTMLElement) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) {
          continue
        }
        const parent = node.parentElement!
        if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return false
        }
        const range = document.createRange()
        range.selectNodeContents(node)
        const lines = [...range.getClientRects()].filter(
          (line) => line.width > 0 && line.height > 0
        )
        if (
          lines.length === 0 ||
          lines.some((line) => line.left < left - 0.5 || line.right > right + 0.5)
        ) {
          return false
        }
        for (
          let ancestor: Element | null = parent;
          ancestor && ancestor !== frame;
          ancestor = ancestor.parentElement
        ) {
          const ancestorStyle = getComputedStyle(ancestor)
          if (ancestorStyle.clipPath !== 'none' || Number(ancestorStyle.opacity) === 0) {
            return false
          }
          if (ancestorStyle.overflowX !== 'visible' || ancestorStyle.overflowY !== 'visible') {
            const box = ancestor.getBoundingClientRect()
            if (
              lines.some(
                (line) =>
                  line.left < box.left - 0.5 ||
                  line.right > box.right + 0.5 ||
                  line.top < box.top - 0.5 ||
                  line.bottom > box.bottom + 0.5
              )
            ) {
              return false
            }
          }
        }
      }
      return true
    }

    const problems: string[] = []
    for (const { anchor, facts, exclude } of scopeList) {
      const start = all.find(
        (element) =>
          textOf(element) === anchor &&
          ![...element.children].some((child) => textOf(child) === anchor)
      )
      if (!start) {
        problems.push(`missing: ${anchor}`)
        continue
      }
      const holds = (element: Element, fact: { text: string; partOf?: true }) =>
        fact.partOf
          ? (element.textContent ?? '').includes(fact.text)
          : [element, ...element.querySelectorAll('*')].some((node) => textOf(node) === fact.text)
      // Widen from the anchor until every fact is inside, without reaching another row or run.
      let scope: HTMLElement = start
      while (!facts.every((fact) => holds(scope, fact))) {
        const parent = scope.parentElement
        if (
          !parent ||
          parent === frame ||
          exclude.some((other) => (parent.textContent ?? '').includes(other))
        ) {
          break
        }
        scope = parent
      }
      for (const fact of facts) {
        const holders = [scope, ...scope.querySelectorAll<HTMLElement>('*')].filter((element) =>
          fact.partOf
            ? (element.textContent ?? '').includes(fact.text) &&
              ![...element.children].some((child) => (child.textContent ?? '').includes(fact.text))
            : textOf(element) === fact.text &&
              ![...element.children].some((child) => textOf(child) === fact.text)
        )
        if (holders.length === 0) {
          problems.push(`${anchor}: missing ${fact.text}`)
        } else if (!holders.some(readable)) {
          problems.push(`${anchor}: not readable ${fact.text}`)
        }
      }
    }
    return problems
  }, scopeList)
}

async function openFixture(page: Page, name: string, theme: 'dark' | 'light' = 'dark') {
  await page.goto(
    `/fixtures.html?id=settings/workspace-cleanup/workspace-cleanup-activity-list:${name}&theme=${theme}`
  )
  // A cold fixture server compiles the module on first load, which can take well past 5s.
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 60_000
  })
}

// Anything the layout clips: boxes past the pane's content box, content spilling out of its own box,
// or text cut with an ellipsis. Only the section's empty screen-reader live regions are exempt.
async function clippedElements(page: Page) {
  return page.locator('#component-fixture-frame').evaluate((frame) => {
    // Measure against the content box: the frame's own padding is not pane space.
    const rect = frame.getBoundingClientRect()
    const style = getComputedStyle(frame)
    const bounds = {
      left: rect.left + Number.parseFloat(style.paddingLeft),
      right: rect.right - Number.parseFloat(style.paddingRight)
    }
    const issues: string[] = []
    for (const element of frame.querySelectorAll<HTMLElement>('*')) {
      const box = element.getBoundingClientRect()
      const liveRegion =
        element.getAttribute('role') === 'status' &&
        getComputedStyle(element).clipPath === 'inset(50%)'
      if (box.width === 0 || box.height === 0 || liveRegion) {
        continue
      }
      const text = element.textContent?.trim().slice(0, 60) ?? ''
      if (box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5) {
        issues.push(`outside the pane: ${text}`)
      }
      if (
        getComputedStyle(element).textOverflow === 'ellipsis' &&
        element.scrollWidth > element.clientWidth + 1
      ) {
        issues.push(`truncated: ${text}`)
      } else if (
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1
      ) {
        issues.push(`overflows its box: ${text}`)
      }
    }
    return issues
  })
}

// Every expected fact must render as visible text with a real box inside the pane. The clip check
// above skips empty and hidden boxes, so this is what proves a fact did not quietly disappear.
async function unreadableFacts(page: Page, facts: string[]) {
  return page.locator('#component-fixture-frame').evaluate((frame, facts) => {
    const rect = frame.getBoundingClientRect()
    const style = getComputedStyle(frame)
    const left = rect.left + Number.parseFloat(style.paddingLeft)
    const right = rect.right - Number.parseFloat(style.paddingRight)
    const problems: string[] = []
    for (const fact of facts) {
      // The innermost elements that hold the whole fact.
      const holders = [...frame.querySelectorAll<HTMLElement>('*')].filter(
        (element) =>
          element.textContent?.includes(fact) &&
          ![...element.children].some((child) => child.textContent?.includes(fact))
      )
      if (holders.length === 0) {
        problems.push(`missing: ${fact}`)
        continue
      }
      for (const holder of holders) {
        const range = document.createRange()
        range.selectNodeContents(holder)
        const lines = [...range.getClientRects()].filter(
          (line) => line.width > 0 && line.height > 0
        )
        // Hidden by an ancestor: clip-path, zero opacity, or overflow clipping that cuts a line off.
        const clipped = (() => {
          for (
            let node: Element | null = holder;
            node && node !== frame;
            node = node.parentElement
          ) {
            const nodeStyle = getComputedStyle(node)
            if (nodeStyle.clipPath !== 'none' || Number(nodeStyle.opacity) === 0) {
              return true
            }
            if (nodeStyle.overflowX !== 'visible' || nodeStyle.overflowY !== 'visible') {
              const box = node.getBoundingClientRect()
              const cut = lines.some(
                (line) =>
                  line.left < box.left - 0.5 ||
                  line.right > box.right + 0.5 ||
                  line.top < box.top - 0.5 ||
                  line.bottom > box.bottom + 0.5
              )
              if (cut) {
                return true
              }
            }
          }
          return false
        })()
        if (
          !holder.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
          clipped ||
          lines.length === 0 ||
          lines.some((line) => line.left < left - 0.5 || line.right > right + 0.5)
        ) {
          problems.push(`not readable: ${fact}`)
        }
      }
    }
    return problems
  }, facts)
}

// Each required reason resolved through its own row: one labelled block inside the row's reason cell, its
// visible icon beside the first text line, every text line inside the box, and clear of the outcome.
async function reasonChipProblems(
  page: Page,
  reasons: { name: string; label: string }[],
  mustWrap: boolean
) {
  return page.locator('#component-fixture-frame').evaluate(
    (frame, { reasons, others, mustWrap }) => {
      const textOf = (element: Element) => element.textContent?.trim() ?? ''
      const innermost = (root: Element, text: string) =>
        [root, ...root.querySelectorAll<HTMLElement>('*')].find(
          (element) =>
            textOf(element) === text &&
            ![...element.children].some((child) => textOf(child) === text)
        )
      const problems: string[] = []
      for (const { name, label } of reasons) {
        const start = innermost(frame, name)
        if (!start) {
          problems.push(`missing: ${name}`)
          continue
        }
        let scope: Element = start
        let labelElement = innermost(scope, label)
        while (!labelElement) {
          const parent = scope.parentElement
          if (
            !parent ||
            parent === frame ||
            others.some((other) => other !== name && textOf(parent).includes(other))
          ) {
            break
          }
          scope = parent
          labelElement = innermost(scope, label)
        }
        if (!labelElement) {
          problems.push(`${name}: missing ${label}`)
          continue
        }
        const chip = labelElement.closest('span[aria-label]')
        if (!chip || !scope.contains(chip)) {
          problems.push(`${name}: reason is not one labelled block`)
          continue
        }
        const boxes = [...chip.getClientRects()]
        if (boxes.length !== 1) {
          problems.push(`${name}: reason renders as ${boxes.length} boxes`)
          continue
        }
        const box = boxes[0]
        const icon = chip.querySelector('svg')
        const iconBox = icon?.getBoundingClientRect()
        if (
          !icon ||
          !iconBox ||
          iconBox.width === 0 ||
          iconBox.height === 0 ||
          !icon.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        ) {
          problems.push(`${name}: reason has no visible icon`)
        }
        const range = document.createRange()
        range.selectNodeContents(labelElement)
        const lines = [...range.getClientRects()].filter(
          (line) => line.width > 0 && line.height > 0
        )
        if (lines.length === 0) {
          problems.push(`${name}: reason text is not visible`)
          continue
        }
        if (
          lines.some(
            (line) =>
              line.left < box.left - 0.5 ||
              line.right > box.right + 0.5 ||
              line.top < box.top - 0.5 ||
              line.bottom > box.bottom + 0.5
          )
        ) {
          problems.push(`${name}: reason text leaves its box`)
        }
        const first = lines[0]
        if (
          iconBox &&
          iconBox.width > 0 &&
          (iconBox.top < first.top - 1 ||
            iconBox.bottom > first.bottom + 1 ||
            iconBox.right > first.left + 0.5)
        ) {
          problems.push(`${name}: icon is not beside the first line`)
        }
        if (mustWrap && new Set(lines.map((line) => Math.round(line.top))).size < 2) {
          problems.push(`${name}: reason did not wrap`)
        }
        // The reason cell: the row's child that holds the box, followed by the outcome.
        let cell: Element = chip
        while (!cell.nextElementSibling && cell.parentElement && cell.parentElement !== frame) {
          cell = cell.parentElement
        }
        const limit = cell.getBoundingClientRect()
        if (box.left < limit.left - 0.5 || box.right > limit.right + 0.5) {
          problems.push(`${name}: reason leaves its cell`)
        }
        let outcome: Element | null = cell.nextElementSibling
        if (outcome && getComputedStyle(outcome).display === 'contents') {
          outcome = outcome.firstElementChild
        }
        const outcomeBox = outcome?.getBoundingClientRect()
        // Side by side only in columns; narrow rows put the outcome on a line of its own.
        if (
          outcomeBox &&
          outcomeBox.top < box.bottom &&
          outcomeBox.bottom > box.top &&
          box.right > outcomeBox.left - 0.5
        ) {
          problems.push(`${name}: reason overlaps its outcome`)
        }
      }
      return problems
    },
    { reasons, others: WORKSPACES, mustWrap }
  )
}

// Sets the fixture's content width and reports the run width and whether removed rows sit in columns.
async function setContentWidth(page: Page, content: number, outcome: string) {
  return page.locator('#component-fixture-frame').evaluate(
    (frame, { content, outcome }) => {
      frame.style.width = `${content + 32}px`
      const textOf = (element: Element) => element.textContent?.trim() ?? ''
      const innermost = (root: Element, text: string) =>
        [...root.querySelectorAll<HTMLElement>('*')].find(
          (element) =>
            textOf(element) === text &&
            ![...element.children].some((child) => textOf(child) === text)
        )
      const run = [...frame.querySelectorAll('[data-settings-row]')].find((row) =>
        row.querySelector('button[aria-expanded]')
      )!
      const name = innermost(frame, 'fix-settings-pane-width')!
      let row: Element = name
      while (!innermost(row, outcome)) {
        row = row.parentElement!
      }
      const nameTop = name.getBoundingClientRect().top
      const outcomeTop = innermost(row, outcome)!.getBoundingClientRect().top
      return {
        run: Math.round(run.getBoundingClientRect().width),
        layout: Math.abs(outcomeTop - nameTop) < 8 ? 'columns' : 'stacked'
      }
    },
    { content, outcome }
  )
}

async function expandEveryRun(page: Page) {
  // A run that couldn't finish and one with nothing to clean start collapsed.
  const collapsed = page.locator('button[aria-expanded="false"]')
  await expect(collapsed).toHaveCount(2)
  while ((await collapsed.count()) > 0) {
    await collapsed.first().click()
  }
}

test.use({ viewport: { width: 1000, height: 2600 } })

for (const { name, locale } of FIXTURES) {
  test(`cleanup activity and status stay readable in ${name}`, async ({ page }) => {
    await openFixture(page, name)
    await expandEveryRun(page)
    const { visible, hiddenUntilShowMore } = expectedFacts(locale)
    const { shown, concealed, afterShowMore } = scopes(locale)
    for (const row of concealed) {
      await expect(page.getByText(row.anchor, { exact: true })).toHaveCount(0)
    }
    expect(await clippedElements(page)).toEqual([])
    expect(await unreadableFacts(page, visible)).toEqual([])
    expect(await scopedFactProblems(page, shown)).toEqual([])

    await page.getByRole('button', { name: SHOW_MORE }).click()
    for (const row of concealed) {
      await expect(page.getByText(row.anchor, { exact: true })).toBeVisible()
    }
    expect(await clippedElements(page)).toEqual([])
    expect(await unreadableFacts(page, [...visible, ...hiddenUntilShowMore])).toEqual([])
    expect(await scopedFactProblems(page, afterShowMore)).toEqual([])
  })
}

// One long kept reason (three ignored-file paths) must not push every other kept row onto two lines.
for (const name of ['wideEnglish', 'wideGerman', 'wideRussian', 'wideJapanese']) {
  test(`kept rows with short reasons keep name and project on one line in ${name}`, async ({
    page
  }) => {
    await openFixture(page, name)
    await page.getByRole('button', { name: SHOW_MORE }).click()
    for (const workspace of ['workspace-1', 'workspace-3', 'workspace-4', 'workspace-5']) {
      const [nameTop, projectTop] = await page
        .getByText(workspace, { exact: true })
        .evaluate((node) => [
          node.getBoundingClientRect().top,
          node.nextElementSibling!.getBoundingClientRect().top
        ])
      expect(Math.abs(nameTop - projectTop), workspace).toBeLessThan(6)
    }
  })
}

// A run header that wraps starts every later line under the date, not under the chevron.
for (const { name } of FIXTURES.filter((fixture) => fixture.name.startsWith('narrow'))) {
  test(`wrapped run headers align under the date in ${name}`, async ({ page }) => {
    await openFixture(page, name)
    const misaligned = await page.locator('#component-fixture-frame').evaluate((frame) => {
      const problems: string[] = []
      for (const header of frame.querySelectorAll<HTMLElement>('button[aria-expanded]')) {
        // The date is the header's first leaf text with a digit.
        const date = [...header.querySelectorAll<HTMLElement>('span')].find(
          (span) => span.childElementCount === 0 && /\d/.test(span.textContent ?? '')
        )
        if (!date) {
          continue
        }
        const start = date.getBoundingClientRect().left
        // Text lines only: element boxes such as a padded wrapper may start further left.
        const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const line of range.getClientRects()) {
            if (line.width > 0 && line.left < start - 0.5) {
              problems.push(
                `"${node.textContent?.trim()}" starts ${start - line.left}px left of the date`
              )
            }
          }
        }
      }
      return problems
    })
    expect(misaligned).toEqual([])
  })
}

// A long reason wraps as one block on its own row: see reasonChipProblems.
const CJK_WORKER = 'オーケストレーションワーカーによって作成された一時的なワークスペース'
const UNBROKEN_GERMAN = 'Inaktivitätsgrenzwertüberschreitungsbereinigungsregel'
// Each fixture's forced labels for the worker and inactive rules.
const FORCED_LONG: Record<string, { worker: string; inactive: string }> = {
  narrowForcedLongReasons: { worker: CJK_WORKER, inactive: UNBROKEN_GERMAN },
  narrowForcedLongReasonsEnglish: {
    worker: 'Temporary workspace created by an orchestration worker for a delegated task',
    inactive: 'Inactivitythresholdexceededautomaticcleanuprule'
  },
  narrowForcedLongReasonsGerman: { worker: CJK_WORKER, inactive: UNBROKEN_GERMAN },
  narrowForcedLongReasonsRussian: {
    worker: 'Временное рабочее пространство, созданное исполнителем оркестрации для поручения',
    inactive: UNBROKEN_GERMAN
  },
  wideBoundaryForcedLongReasons: { worker: CJK_WORKER, inactive: UNBROKEN_GERMAN }
}
for (const [name, forced] of Object.entries(FORCED_LONG)) {
  test(`forced long reasons wrap inside one box in ${name}`, async ({ page }) => {
    await openFixture(page, name)
    // Every forced label reads in full on its own row, not just whichever one happens to wrap.
    expect(
      await scopedFactProblems(page, [
        rowScope('worker-translate-catalogs', [forced.worker]),
        rowScope('investigate-flaky-settings-pane-layout-on-minimum-window', [forced.inactive])
      ])
    ).toEqual([])
    expect(
      await reasonChipProblems(
        page,
        [
          { name: 'worker-translate-catalogs', label: forced.worker },
          {
            name: 'investigate-flaky-settings-pane-layout-on-minimum-window',
            label: forced.inactive
          }
        ],
        true
      )
    ).toEqual([])
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`wrapped neutral reasons are plain text, not boxes, in ${theme}`, async ({ page }) => {
    await openFixture(page, 'narrowForcedLongReasonsEnglish', theme)
    const forced = FORCED_LONG.narrowForcedLongReasonsEnglish
    const report = await page.locator('#component-fixture-frame').evaluate(
      (frame, labels) => {
        const style = (label: string) => {
          const block = [...frame.querySelectorAll<HTMLElement>('span[aria-label]')].find(
            (span) => span.getAttribute('aria-label') === label
          )
          if (!block) {
            return null
          }
          const computed = getComputedStyle(block)
          return {
            fill: computed.backgroundColor,
            border: Number.parseFloat(computed.borderTopWidth)
          }
        }
        const merged = [...frame.querySelectorAll<HTMLElement>('span[aria-label]')].find((span) =>
          span.getAttribute('aria-label')?.includes('#42')
        )
        return {
          neutral: labels.map((label) => ({ label: label.slice(0, 30), ...style(label) })),
          mergedBorder: merged ? Number.parseFloat(getComputedStyle(merged).borderTopWidth) : null
        }
      },
      [forced.worker, forced.inactive]
    )
    // A wrapped neutral reason is an icon and muted text, like a kept reason: no fill, no border.
    for (const reason of report.neutral) {
      expect(reason, reason.label).toMatchObject({ fill: 'rgba(0, 0, 0, 0)', border: 0 })
    }
    // The merged pull request keeps its tone chip.
    expect(report.mergedBorder).toBeGreaterThan(0)
  })
}

// The column switch is at 618px of content (a 576px run). Facts stay with their rows on both sides of it.
for (const content of [617, 618, 619]) {
  test(`facts stay with their rows across the column switch at ${content}px`, async ({ page }) => {
    await openFixture(page, 'wideGerman')
    expect(await setContentWidth(page, content, LABELS.de.deleted)).toEqual({
      run: content - 42,
      layout: content >= 618 ? 'columns' : 'stacked'
    })
    await expandEveryRun(page)
    const { visible, hiddenUntilShowMore } = expectedFacts('de')
    const { shown, concealed, afterShowMore } = scopes('de')
    for (const row of concealed) {
      await expect(page.getByText(row.anchor, { exact: true })).toHaveCount(0)
    }
    expect(await clippedElements(page)).toEqual([])
    expect(await unreadableFacts(page, visible)).toEqual([])
    expect(await scopedFactProblems(page, shown)).toEqual([])

    await page.getByRole('button', { name: SHOW_MORE }).click()
    for (const row of concealed) {
      await expect(page.getByText(row.anchor, { exact: true })).toBeVisible()
    }
    expect(await clippedElements(page)).toEqual([])
    expect(await unreadableFacts(page, [...visible, ...hiddenUntilShowMore])).toEqual([])
    expect(await scopedFactProblems(page, afterShowMore)).toEqual([])
  })
}
